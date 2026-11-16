import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import path from "node:path";
import { hostname, userInfo } from "node:os";
import { z } from "zod";
import { atomicWriteJson } from "./state.ts";
import { coordinationRecordSchema as baseRecordSchema, coordinationRecordViewSchema as recordSchema, coordinationTokenSchema, coordinationExecutionSchema, coordinationRecoveryIntentSchema, type CoordinationRecordView as CoordinationRecord, type CoordinationToken, type CoordinationExecution, type CoordinationResolution } from "../../../packages/protocol/src/coordination.ts";

export const coordinationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const coordinationDevice = coordinationHash(hostname());
export const coordinationIdentity = coordinationHash(typeof process.getuid === "function" ? [process.getuid()] : [userInfo().username.toLowerCase()]);
export type TerminalJobEvidence = { id: string; device: string; identity: string; state: "completed" | "cancelled" | "lost" };
/** Internal evidence, constructed from the existing job/containment stores, never request fields. */
export type ReconciliationJobEvidence = TerminalJobEvidence & { containmentVerified: boolean; evidenceHash: string; key?: string; fingerprint?: string; exitCode?: number | null };
export function coordinationBootIdentity(): string | null {
  if (process.platform !== "linux") return null;
  try { const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); return z.string().uuid().safeParse(id).success ? "linux:" + id : null; }
  catch { return null; }
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const journalSnapshotSchema = { originalJournal: z.string().max(16_384), originalJournalHash: hash };
const archiveSchema = z.object({ version: z.literal(1), original: recordSchema, resolved: recordSchema, ...journalSnapshotSchema }).strict();
const intentArchiveSchema = z.object({ intent: coordinationRecoveryIntentSchema, original: recordSchema, ...journalSnapshotSchema, integrityHash: hash }).strict();
const executionArchiveSchema = z.object({ version: z.literal(1), token: coordinationTokenSchema, device: hash, identity: hash, execution: coordinationExecutionSchema }).strict();
const journalHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function coordinationPublicRecord(record: CoordinationRecord) { const { execution: _execution, resolution: _resolution, ...base } = record; return baseRecordSchema.parse(base); }
export function coordinationRecoveryView(record: CoordinationRecord | null) { return { execution: record?.execution ?? null, resolution: record?.resolution ?? null }; }
export type ResourceVersion = { device: string; identity: string; canonicalKey: string; baseVersion: string };
type Override = { expectedGeneration: number; expectedBaseVersion: string; reason: "abandoned_reservation" | "owner_takeover" };
export class CoordinationError extends Error {
  readonly reason: string; readonly record: CoordinationRecord | null;
  constructor(reason: string, record: CoordinationRecord | null = null) { super(`coordination_conflict: ${reason}`); this.reason = reason; this.record = record; }
  toJSON() { return { error: "coordination_conflict", code: "COORDINATION_CONFLICT", details: { reason: this.reason, coordination: this.record ? coordinationPublicRecord(this.record) : null } }; }
}

/** Sharing is opt-in; directory ownership/group membership is provisioned externally. */
export function coordinationFileMode(value?: string): number {
  if (value === undefined || value === "0600" || value === "600") return 0o600;
  if (value === "0660" || value === "660") return 0o660;
  throw new Error("RCMCP_COORDINATION_FILE_MODE must be 0600 or 0660");
}

/** Configure only newly created directories; existing ownership, ACLs and modes
 * remain the operator's responsibility. Keep inherited setgid for later writers. */
export function ensureCoordinationDirectory(directory: string, fileMode = 0o600): string {
  if (fileMode !== 0o600 && fileMode !== 0o660) throw new Error("Invalid coordination file mode");
  const mode = fileMode === 0o660 ? 0o770 : 0o700;
  try { mkdirSync(directory, { mode }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && path.dirname(directory) !== directory) {
      ensureCoordinationDirectory(path.dirname(directory), fileMode);
      return ensureCoordinationDirectory(directory, fileMode);
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && statSync(directory).isDirectory()) return directory;
    throw error;
  }
  if (process.platform !== "win32") {
    const fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try { fchmodSync(fd, mode | (fstatSync(fd).mode & 0o2000)); } finally { closeSync(fd); }
  }
  return directory;
}

/** Short, fail-fast per-resource disk transactions; never hold a resource lock during I/O or execution.
 * Active/uncertain evidence is never expired or evicted. A crash-held admission lock
 * requires inspection, not a PID/age heuristic that could admit two writers. */
export class ResourceCoordinator {
  readonly instanceId = randomUUID();
  readonly root: string; readonly activeBudget: number; readonly fileMode: number; private now: () => number;
  private bootIdentity: () => string | null;
  constructor(root: string, activeBudget = 4, now = Date.now, fileMode = 0o600, bootIdentity = coordinationBootIdentity) { if (fileMode !== 0o600 && fileMode !== 0o660) throw new Error("Invalid coordination file mode"); if (!Number.isInteger(activeBudget) || activeBudget < 1 || activeBudget > 4) throw new Error("Invalid coordination budget"); this.fileMode = fileMode; this.root = root; this.activeBudget = activeBudget; this.now = now; this.bootIdentity = bootIdentity; ensureCoordinationDirectory(root, fileMode); }
  resourceId(resource: ResourceVersion) { return coordinationHash([resource.device, resource.canonicalKey]); }
  private file(id: string) { if (!hash.safeParse(id).success) throw new CoordinationError("invalid_resource"); return path.join(this.root, id + ".json"); }
  private read(id: string): CoordinationRecord | null {
    let fd: number;
    try { fd = openSync(this.file(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new CoordinationError("state_invalid"); }
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 16_384) throw new Error();
      const record: CoordinationRecord = baseRecordSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (record.resourceId !== id) throw new Error();
      const execution = this.artifact(this.executionFile(coordinationToken(record)), executionArchiveSchema);
      if (execution) {
        if (coordinationHash(execution.token) !== coordinationHash(coordinationToken(record)) || execution.device !== record.device || execution.identity !== record.identity) throw new Error();
        record.execution = execution.execution;
      }
      if (record.state === "released") {
        const archive = this.artifact(this.archiveFile(coordinationToken(record)), archiveSchema);
        if (archive) {
          // The v1 acquire path refreshes updatedAt on an already released
          // journal before reserving its successor. A rollback interrupted there
          // may change only this timestamp; every other field must still match.
          if (coordinationHash(coordinationPublicRecord(archive.resolved)) !== coordinationHash({ ...coordinationPublicRecord(record), updatedAt: archive.resolved.updatedAt })) throw new Error();
          if (coordinationHash(record.execution ?? null) !== coordinationHash(archive.resolved.execution ?? null)) throw new Error();
          record.resolution = archive.resolved.resolution;
        }
      }
      return record;
    } catch { throw new CoordinationError("state_invalid"); }
    finally { closeSync(fd); }
  }
  private save(record: CoordinationRecord) { recordSchema.parse(record); atomicWriteJson(this.file(record.resourceId), coordinationPublicRecord(record), this.fileMode); }
  private journalSnapshot(record: CoordinationRecord) {
    const fd = openSync(this.file(record.resourceId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 16_384) throw new CoordinationError("state_invalid");
      const originalJournal = readFileSync(fd, "utf8");
      if (coordinationHash(baseRecordSchema.parse(JSON.parse(originalJournal))) !== coordinationHash(coordinationPublicRecord(record))) throw new CoordinationError("recovery_record_changed", record);
      return { originalJournal, originalJournalHash: journalHash(originalJournal) };
    } finally { closeSync(fd); }
  }
  private artifact<T>(file: string, schema: z.ZodType<T>): T | null {
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new CoordinationError("recovery_evidence_invalid"); }
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 65_536) throw new Error(); return schema.parse(JSON.parse(readFileSync(fd, "utf8"))); }
    catch { throw new CoordinationError("recovery_evidence_invalid"); }
    finally { closeSync(fd); }
  }
  private artifactDirectory(name: string) { return ensureCoordinationDirectory(path.join(this.root, name), this.fileMode); }
  private archiveFile(token: CoordinationToken) { coordinationTokenSchema.parse(token); return path.join(this.root, "reconciliations", `${token.resourceId}-${token.operationId}.json`); }
  private executionFile(token: CoordinationToken) { coordinationTokenSchema.parse(token); return path.join(this.root, "executions", `${token.resourceId}-${token.operationId}.json`); }
  private checkRecoveryCapacity(name: string) { if (readdirSync(this.artifactDirectory(name)).length >= 4096) throw new CoordinationError("recovery_retention_full"); }
  private assertResource(record: CoordinationRecord, resource: ResourceVersion, expectedBase?: string) {
    if (record.resourceId !== this.resourceId(resource) || record.device !== resource.device || record.identity !== resource.identity || record.canonicalKey !== resource.canonicalKey) throw new CoordinationError("resource_or_identity_changed", record);
    if (!expectedBase || !hash.safeParse(expectedBase).success || resource.baseVersion !== expectedBase) throw new CoordinationError("recovery_base_changed", record);
  }
  /** Read an earlier disposition without touching a newer generation. Finish only its own interrupted publication. */
  private archived(token: CoordinationToken, resource: ResourceVersion, expectedBase: string, intentId?: string) {
    const archive = this.artifact(this.archiveFile(token), archiveSchema);
    if (!archive) return null;
    const resolved = archive.resolved, resolution = resolved.resolution;
    if (coordinationHash(coordinationToken(archive.original)) !== coordinationHash(token) || !resolution
      || resolved.state !== "released" || resolution.originalRecordHash !== coordinationHash(archive.original)
      || archive.originalJournalHash !== journalHash(archive.originalJournal) || resolution.originalJournalHash !== archive.originalJournalHash
      || coordinationHash(baseRecordSchema.parse(JSON.parse(archive.originalJournal))) !== coordinationHash(coordinationPublicRecord(archive.original))
      || coordinationHash(coordinationToken(resolved)) !== coordinationHash(token)
      || resolution.recoveryIntentId !== intentId) throw new CoordinationError("recovery_evidence_mismatch");
    this.assertResource(resolved, { ...resource, baseVersion: expectedBase }, expectedBase);
    const current = this.read(token.resourceId);
    if (!current || current.generation < token.generation || current.generation === token.generation && current.operationId !== token.operationId) throw new CoordinationError("recovery_record_changed", current);
    const pending = current.operationId === token.operationId && current.generation === token.generation && coordinationHash(current) === coordinationHash(archive.original);
    if (!pending && expectedBase !== resolution.observedBaseVersion && expectedBase !== resource.baseVersion) throw new CoordinationError("recovery_base_changed", current);
    if (current?.operationId === token.operationId && current.generation === token.generation) {
      if (current.state === "released" && current.updatedAt !== resolved.updatedAt && coordinationHash({ ...current, updatedAt: resolved.updatedAt }) === coordinationHash(resolved)) {
        // A baseline agent refreshed only the timestamp after release. Preserve
        // its valid v1 bytes; this is a historical lookup, not a pending release.
        return { record: resolved, alreadyReconciled: true, noReplay: true as const };
      }
      if (coordinationHash(current) !== coordinationHash(archive.original) && coordinationHash(current) !== coordinationHash(resolved)) throw new CoordinationError("recovery_record_changed", current);
      if (pending) {
        // A receipt lookup may ignore later resource changes only after release
        // was published. Finishing a pending release is still a fenced mutation.
        this.assertResource(current, resource, expectedBase);
        if (expectedBase !== resolution.observedBaseVersion) throw new CoordinationError("recovery_evidence_mismatch", current);
        if (!this.ownsSlot(current)) throw new CoordinationError("budget_fence_changed", current);
        if (this.journalSnapshot(current).originalJournalHash !== archive.originalJournalHash) throw new CoordinationError("recovery_record_changed", current);
      }
      // A previous write may have renamed its file but failed directory fsync.
      // Confirm archive durability before completing that interrupted release.
      atomicWriteJson(this.archiveFile(token), archive, this.fileMode);
      this.save(resolved); this.freeSlot(resolved);
    }
    return { record: resolved, alreadyReconciled: true, noReplay: true as const };
  }
  private resolve(record: CoordinationRecord, resource: ResourceVersion, resolution: Omit<CoordinationResolution, "at" | "originalRecordHash" | "originalJournalHash" | "observedBaseVersion" | "effectVerification" | "noReplay">) {
    if (!this.ownsSlot(record)) throw new CoordinationError("budget_fence_changed", record);
    const snapshot = this.journalSnapshot(record);
    const complete: CoordinationResolution = { ...resolution, at: new Date(this.now()).toISOString(), originalRecordHash: coordinationHash(record), originalJournalHash: snapshot.originalJournalHash, observedBaseVersion: resource.baseVersion, effectVerification: "unverified", noReplay: true };
    const resolved: CoordinationRecord = { ...record, state: "released", conflictReason: null, updatedAt: complete.at, resolution: complete };
    this.checkRecoveryCapacity("reconciliations");
    // Preserve the original before publishing release. A failed publication stays fenced;
    // the same request can finish this exact archived transition after restart.
    atomicWriteJson(this.archiveFile(coordinationToken(record)), { version: 1, original: record, resolved, ...snapshot }, this.fileMode);
    this.save(resolved); this.freeSlot(resolved);
    return { record: resolved, alreadyReconciled: false, noReplay: true as const };
  }
  private transaction<T>(id: string, fn: () => T): T {
    const file = this.file(id) + ".lock";
    let fd: number;
    try { fd = openSync(file, "wx", this.fileMode); } catch { throw new CoordinationError("admission_locked"); }
    try { fchmodSync(fd, this.fileMode); return fn(); } finally { closeSync(fd); unlinkSync(file); }
  }
  private slotFile(device: string, slot: number) { return path.join(this.root, `slot-${device}-${slot}.json`); }
  private slot(device: string, slot: number): { resourceId: string; operationId: string } | null {
    try {
      const file = this.slotFile(device, slot), fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { if (fstatSync(fd).size > 512) throw new Error(); return z.object({ resourceId: hash, operationId: z.string().uuid() }).strict().parse(JSON.parse(readFileSync(fd, "utf8"))); }
      finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new CoordinationError("budget_state_invalid"); }
  }
  private ownsSlot(record: CoordinationRecord) { const slot = this.slot(record.device, record.budgetSlot); return slot?.operationId === record.operationId && slot.resourceId === record.resourceId; }
  private freeSlot(record: CoordinationRecord) { if (this.ownsSlot(record)) unlinkSync(this.slotFile(record.device, record.budgetSlot)); }
  private reserveSlot(device: string, resourceId: string, operationId: string): number {
    for (let slot = 0; slot < this.activeBudget; slot++) {
      let previous: ReturnType<ResourceCoordinator["slot"]>;
      try { previous = this.slot(device, slot); } catch (error) { if (error instanceof CoordinationError) continue; throw error; }
      if (previous && previous.resourceId !== resourceId) {
        // Reclaim only under the referenced resource's fence. Never take a slot
        // from an active/uncertain writer, or from an orphan resource lock.
        try { this.transaction(previous.resourceId, () => {
          const current = this.slot(device, slot);
          if (current?.operationId !== previous.operationId) return;
          const record = this.read(previous.resourceId);
          // Missing/mismatched journals are orphan evidence, never free capacity.
          if (!record || record.operationId !== previous.operationId || record.budgetSlot !== slot || record.device !== device) return;
          if (!(record.state === "released" || record.state === "reserved" && record.expiresAt <= this.now())) return;
          if (record?.operationId === previous.operationId && record.state === "reserved") { record.state = "released"; record.updatedAt = new Date(this.now()).toISOString(); this.save(record); }
          unlinkSync(this.slotFile(device, slot));
        }); } catch (error) { if (!(error instanceof CoordinationError && ["admission_locked", "state_invalid", "budget_state_invalid"].includes(error.reason))) throw error; }
      }
      let fd: number;
      try { fd = openSync(this.slotFile(device, slot), "wx", this.fileMode); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      try { fchmodSync(fd, this.fileMode); writeFileSync(fd, JSON.stringify({ resourceId, operationId })); fsyncSync(fd); } finally { closeSync(fd); }
      return slot;
    }
    throw new CoordinationError("device_backpressure");
  }
  activeRecords() { return readdirSync(this.root).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).flatMap(f => { try { const record = this.read(f.slice(0, -5)); return record ? [record] : []; } catch { return []; } }).filter(r => r.state === "active"); }
  private inspection(resource: ResourceVersion, record: CoordinationRecord | null) {
    return { resourceId: this.resourceId(resource), device: resource.device, identity: resource.identity, canonicalKey: resource.canonicalKey,
      observedBaseVersion: resource.baseVersion, record: record ? coordinationPublicRecord(record) : null, activeBudget: this.activeBudget };
  }
  inspect(resource: ResourceVersion) { return this.inspection(resource, this.current(resource)); }
  current(resource: ResourceVersion) { return this.read(this.resourceId(resource)); }
  inspectRecovery(resource: ResourceVersion) { const record = this.current(resource); return { ...this.inspection(resource, record), recovery: coordinationRecoveryView(record) }; }
  acquire(resource: ResourceVersion, leaseMs = 30_000, override?: Override): CoordinationRecord {
    return this.transaction(this.resourceId(resource), () => {
      const id = this.resourceId(resource), previous = this.read(id), now = this.now();
      // A slot can survive a failed journal publication. Do not replace its
      // resource just because the journal is missing or belongs to another run.
      for (let slot = 0; slot < this.activeBudget; slot++) {
        let held;
        try { held = this.slot(resource.device, slot); }
        catch (error) { if (error instanceof CoordinationError) continue; throw error; }
        if (held?.resourceId === id && (!previous || held.operationId !== previous.operationId || previous.budgetSlot !== slot)) {
          throw new CoordinationError("orphan_resource_slot", previous);
        }
      }
      if (override && (override.expectedGeneration !== (previous?.generation ?? 0) || override.expectedBaseVersion !== resource.baseVersion)) throw new CoordinationError("override_base_changed", previous);
      if (previous && ["active", "uncertain"].includes(previous.state)) throw new CoordinationError("active_or_uncertain_writer", previous);
      if (previous?.state === "reserved" && previous.expiresAt > now && !override) throw new CoordinationError("writer_reserved", previous);
      if (override && previous && previous.overrides.length >= 32) throw new CoordinationError("override_audit_full", previous);
      const files = readdirSync(this.root).filter(f => /^[a-f0-9]{64}\.json$/.test(f));
      if (!previous && files.length >= 512) throw new CoordinationError("resource_retention_full");
      const operationId = randomUUID(), at = new Date(now).toISOString();
      if (previous) {
        if (previous.state !== "released") { previous.state = "released"; previous.updatedAt = at; this.save(previous); }
        this.freeSlot(previous);
      }
      const budgetSlot = this.reserveSlot(resource.device, id, operationId);
      const record: CoordinationRecord = { version: 1, budgetSlot, resourceId: id, ...resource, operationId,
        generation: (previous?.generation ?? 0) + 1, state: "reserved", createdAt: at, updatedAt: at,
        expiresAt: now + leaseMs, instanceId: this.instanceId, conflictReason: null,
        overrides: [...(previous?.overrides ?? []), ...(override && previous ? [{ operationId, previousOperationId: previous.operationId, at, reason: override.reason }] : [])] };
      this.save(record); return record;
    });
  }
  private match(token: CoordinationToken) {
    coordinationTokenSchema.parse(token);
    const record = this.read(token.resourceId);
    if (!record || record.generation !== token.generation || record.operationId !== token.operationId || record.baseVersion !== token.baseVersion) throw new CoordinationError("stale_writer", record);
    return record;
  }
  begin(token: CoordinationToken, resource: ResourceVersion) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token);
      const reason = record.state !== "reserved" ? "writer_not_reserved" : !this.ownsSlot(record) ? "budget_fence_changed" : record.expiresAt <= this.now() ? "lease_expired"
        : record.resourceId !== this.resourceId(resource) || record.identity !== resource.identity ? "resource_or_identity_changed"
        : record.baseVersion !== resource.baseVersion ? "base_changed" : null;
      if (reason) throw new CoordinationError(reason, record);
      record.state = "active"; record.updatedAt = new Date(this.now()).toISOString(); this.save(record); return record;
    });
  }
  release(token: CoordinationToken) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token);
      if (record.state !== "reserved") throw new CoordinationError("active_or_uncertain_writer", record);
      record.state = "released"; record.updatedAt = new Date(this.now()).toISOString(); this.save(record); this.freeSlot(record); return record;
    });
  }
  bindExecution(token: CoordinationToken, execution: CoordinationExecution) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token); coordinationExecutionSchema.parse(execution);
      if (record.state !== "active" || !this.ownsSlot(record)) throw new CoordinationError("writer_not_active", record);
      if (record.execution && coordinationHash(record.execution) !== coordinationHash(execution)) throw new CoordinationError("execution_binding_mismatch", record);
      // Refuse before effects when the eventual disposition cannot be retained.
      // This preflight is not a reservation against concurrent archive writers.
      this.checkRecoveryCapacity("reconciliations");
      // Immutable sidecar, published in the same resource transaction before any
      // job reservation/dispatch. Legacy v1 journals remain byte-schema compatible.
      const file = this.executionFile(token), previous = this.artifact(file, executionArchiveSchema);
      const archive = { version: 1 as const, token, device: record.device, identity: record.identity, execution };
      if (previous && coordinationHash(previous) !== coordinationHash(archive)) throw new CoordinationError("execution_binding_mismatch", record);
      if (!previous) { this.checkRecoveryCapacity("executions"); atomicWriteJson(file, archive, this.fileMode); }
      else atomicWriteJson(file, previous, this.fileMode); // confirm a prior interrupted publication
      record.execution = execution; return record;
    });
  }
  attachJob(token: CoordinationToken, jobId: string) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token); z.string().uuid().parse(jobId);
      if (!record.execution || !["active", "uncertain"].includes(record.state) || record.jobId && record.jobId !== jobId) throw new CoordinationError("execution_binding_mismatch", record);
      record.jobId = jobId; record.updatedAt = new Date(this.now()).toISOString(); this.save(record); return record;
    });
  }
  prepareRecovery(token: CoordinationToken, resource: ResourceVersion, expectedBase: string) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token); this.assertResource(record, resource, expectedBase);
      if (!["active", "uncertain"].includes(record.state)) throw new CoordinationError("writer_not_recoverable", record);
      const id = coordinationHash([token, coordinationHash(record), expectedBase]);
      const file = path.join(this.artifactDirectory("recovery-intents"), id + ".json");
      const previousArchive = this.artifact(file, intentArchiveSchema), previous = previousArchive?.intent;
      if (previous) {
        if (previous.id !== id || previous.originalRecordHash !== coordinationHash(record) || coordinationHash(previous.token) !== coordinationHash(token)
          || previous.device !== record.device || previous.identity !== record.identity || previous.observedBaseVersion !== expectedBase
          || previous.originalJournalHash !== this.journalSnapshot(record).originalJournalHash || previous.originalJournalHash !== previousArchive!.originalJournalHash
          || journalHash(previousArchive!.originalJournal) !== previous.originalJournalHash || coordinationHash(previousArchive!.original) !== coordinationHash(record)
          || previousArchive!.integrityHash !== coordinationHash([previous, previousArchive!.original, previousArchive!.originalJournalHash])) throw new CoordinationError("recovery_intent_mismatch", record);
        atomicWriteJson(file, previousArchive, this.fileMode);
        return { recoveryIntent: previous, record, noReplay: true as const };
      }
      const bootIdentity = this.bootIdentity();
      if (!bootIdentity || !/^linux:[a-f0-9-]{36}$/.test(bootIdentity)) throw new CoordinationError("boot_identity_unavailable", record);
      this.checkRecoveryCapacity("recovery-intents");
      const snapshot = this.journalSnapshot(record);
      const recoveryIntent = coordinationRecoveryIntentSchema.parse({ version: 1, id, token, device: record.device, identity: record.identity, canonicalKey: record.canonicalKey,
        originalRecordHash: coordinationHash(record), originalJournalHash: snapshot.originalJournalHash, observedBaseVersion: expectedBase, bootIdentity, createdAt: new Date(this.now()).toISOString(), noReplay: true });
      atomicWriteJson(file, { intent: recoveryIntent, original: record, ...snapshot, integrityHash: coordinationHash([recoveryIntent, record, snapshot.originalJournalHash]) }, this.fileMode);
      return { recoveryIntent, record, noReplay: true as const };
    });
  }
  reconciled(token: CoordinationToken, resource: ResourceVersion, expectedBase: string, intentId?: string) {
    return this.transaction(token.resourceId, () => this.archived(token, resource, expectedBase, intentId));
  }
  reconcileJob(token: CoordinationToken, resource: ResourceVersion, expectedBase: string, evidence: ReconciliationJobEvidence) {
    return this.transaction(token.resourceId, () => {
      const previous = this.archived(token, resource, expectedBase); if (previous) return previous;
      const record = this.match(token); this.assertResource(record, resource, expectedBase);
      if (!["active", "uncertain"].includes(record.state) || !record.execution) throw new CoordinationError("execution_binding_unavailable", record);
      if (record.device !== evidence.device || record.identity !== evidence.identity || record.execution.key !== evidence.key || record.execution.fingerprint !== evidence.fingerprint || record.jobId && record.jobId !== evidence.id) throw new CoordinationError("job_evidence_mismatch", record);
      if (!evidence.containmentVerified || !["completed", "cancelled", "lost"].includes(evidence.state) || !hash.safeParse(evidence.evidenceHash).success) throw new CoordinationError("termination_unverified", record);
      return this.resolve(record, resource, { kind: "durable_job", jobId: evidence.id, evidenceHash: evidence.evidenceHash, outcome: evidence.state === "lost" ? "unknown" : evidence.state });
    });
  }
  reconcileRecovery(token: CoordinationToken, resource: ResourceVersion, expectedBase: string, intentId: string, containment?: ReconciliationJobEvidence) {
    return this.transaction(token.resourceId, () => {
      hash.parse(intentId);
      const previous = this.archived(token, resource, expectedBase, intentId); if (previous) return previous;
      const record = this.match(token); this.assertResource(record, resource, expectedBase);
      if (!["active", "uncertain"].includes(record.state)) throw new CoordinationError("writer_not_recoverable", record);
      const intentArchive = this.artifact(path.join(this.artifactDirectory("recovery-intents"), intentId + ".json"), intentArchiveSchema), intent = intentArchive?.intent;
      if (!intent || intent.id !== intentId || coordinationHash(intent.token) !== coordinationHash(token) || intent.device !== record.device || intent.identity !== record.identity || intent.canonicalKey !== record.canonicalKey
        || intent.originalRecordHash !== coordinationHash(record)
        || intent.originalJournalHash !== this.journalSnapshot(record).originalJournalHash || intent.originalJournalHash !== intentArchive!.originalJournalHash
        || journalHash(intentArchive!.originalJournal) !== intent.originalJournalHash || coordinationHash(intentArchive!.original) !== coordinationHash(record)
        || intentArchive!.integrityHash !== coordinationHash([intent, intentArchive!.original, intentArchive!.originalJournalHash])) throw new CoordinationError("recovery_intent_mismatch", record);
      if (containment && record.jobId === containment.id && containment.device === record.device && containment.identity === record.identity && containment.containmentVerified && hash.safeParse(containment.evidenceHash).success) {
        return this.resolve(record, resource, { kind: "durable_job", jobId: containment.id, evidenceHash: containment.evidenceHash, recoveryIntentId: intentId, preparedBaseVersion: intent.observedBaseVersion, outcome: "unknown" });
      }
      const bootIdentity = this.bootIdentity();
      if (!bootIdentity || !/^linux:[a-f0-9-]{36}$/.test(bootIdentity) || bootIdentity === intent.bootIdentity) throw new CoordinationError("quiescence_unverified", record);
      return this.resolve(record, resource, { kind: "boot_transition", evidenceHash: coordinationHash([intent, bootIdentity]), recoveryIntentId: intentId, preparedBaseVersion: intent.observedBaseVersion, outcome: "unknown" });
    });
  }
  settle(token: CoordinationToken, outcome: { jobId?: string; uncertain?: boolean; jobEvidence?: TerminalJobEvidence } = {}) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token);
      if (record.state !== "active") throw new CoordinationError("writer_not_active", record);
      // A reconciliation may have published its archive before a later fsync or
      // journal write failed. Do not change the record that archive binds.
      if (this.artifact(this.archiveFile(token), archiveSchema)) throw new CoordinationError("reconciliation_pending", record);
      if (outcome.jobEvidence) {
        const evidence = outcome.jobEvidence;
        if (record.jobId !== evidence.id || record.device !== evidence.device || record.identity !== evidence.identity) throw new CoordinationError("job_evidence_mismatch", record);
        if (evidence.state !== "completed" && evidence.state !== "cancelled" && evidence.state !== "lost") throw new CoordinationError("job_evidence_not_terminal", record);
        outcome = { uncertain: evidence.state === "lost" };
      }
      record.state = outcome.uncertain ? "uncertain" : outcome.jobId ? "active" : "released";
      if (outcome.jobId) record.jobId = outcome.jobId;
      record.conflictReason = outcome.uncertain ? "effect_or_termination_unverified" : null;
      record.updatedAt = new Date(this.now()).toISOString(); this.save(record);
      if (record.state === "released") this.freeSlot(record);
      return record;
    });
  }
}
export function coordinationToken(record: CoordinationRecord): CoordinationToken { return coordinationTokenSchema.parse({ resourceId: record.resourceId, operationId: record.operationId, generation: record.generation, baseVersion: record.baseVersion }); }
