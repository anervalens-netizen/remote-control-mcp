import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import path from "node:path";
import { hostname, userInfo } from "node:os";
import { z } from "zod";
import { atomicWriteJson } from "./state.ts";
import { coordinationRecordSchema as recordSchema, coordinationTokenSchema, type CoordinationRecord, type CoordinationToken } from "../../../packages/protocol/src/coordination.ts";

export const coordinationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const coordinationDevice = coordinationHash(hostname());
export const coordinationIdentity = coordinationHash(typeof process.getuid === "function" ? [process.getuid()] : [userInfo().username.toLowerCase()]);
export type TerminalJobEvidence = { id: string; device: string; identity: string; state: "completed" | "cancelled" | "lost" };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export type ResourceVersion = { device: string; identity: string; canonicalKey: string; baseVersion: string };
type Override = { expectedGeneration: number; expectedBaseVersion: string; reason: "abandoned_reservation" | "owner_takeover" };
export class CoordinationError extends Error {
  readonly reason: string; readonly record: CoordinationRecord | null;
  constructor(reason: string, record: CoordinationRecord | null = null) { super(`coordination_conflict: ${reason}`); this.reason = reason; this.record = record; }
  toJSON() { return { error: "coordination_conflict", code: "COORDINATION_CONFLICT", details: { reason: this.reason, coordination: this.record } }; }
}

/** Sharing is opt-in; directory ownership/group membership is provisioned externally. */
export function coordinationFileMode(value?: string): number {
  if (value === undefined || value === "0600" || value === "600") return 0o600;
  if (value === "0660" || value === "660") return 0o660;
  throw new Error("RCMCP_COORDINATION_FILE_MODE must be 0600 or 0660");
}

/** Short, fail-fast per-resource disk transactions; never hold a resource lock during I/O or execution.
 * Active/uncertain evidence is never expired or evicted. A crash-held admission lock
 * requires inspection, not a PID/age heuristic that could admit two writers. */
export class ResourceCoordinator {
  readonly instanceId = randomUUID();
  readonly root: string; readonly activeBudget: number; readonly fileMode: number; private now: () => number;
  constructor(root: string, activeBudget = 4, now = Date.now, fileMode = 0o600) { if (fileMode !== 0o600 && fileMode !== 0o660) throw new Error("Invalid coordination file mode"); if (!Number.isInteger(activeBudget) || activeBudget < 1 || activeBudget > 4) throw new Error("Invalid coordination budget"); this.fileMode = fileMode; this.root = root; this.activeBudget = activeBudget; this.now = now; mkdirSync(root, { recursive: true, mode: 0o700 }); }
  resourceId(resource: ResourceVersion) { return coordinationHash([resource.device, resource.canonicalKey]); }
  private file(id: string) { if (!hash.safeParse(id).success) throw new CoordinationError("invalid_resource"); return path.join(this.root, id + ".json"); }
  private read(id: string): CoordinationRecord | null {
    let fd: number;
    try { fd = openSync(this.file(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new CoordinationError("state_invalid"); }
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 16_384) throw new Error();
      const record = recordSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (record.resourceId !== id) throw new Error();
      return record;
    } catch { throw new CoordinationError("state_invalid"); }
    finally { closeSync(fd); }
  }
  private save(record: CoordinationRecord) { recordSchema.parse(record); atomicWriteJson(this.file(record.resourceId), record, this.fileMode); }
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
  inspect(resource: ResourceVersion) {
    const record = this.read(this.resourceId(resource));
    return { resourceId: this.resourceId(resource), device: resource.device, identity: resource.identity, canonicalKey: resource.canonicalKey,
      observedBaseVersion: resource.baseVersion, record, activeBudget: this.activeBudget };
  }
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
      if (previous) { previous.state = "released"; previous.updatedAt = at; this.save(previous); this.freeSlot(previous); }
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
  settle(token: CoordinationToken, outcome: { jobId?: string; uncertain?: boolean; jobEvidence?: TerminalJobEvidence } = {}) {
    return this.transaction(token.resourceId, () => {
      const record = this.match(token);
      if (record.state !== "active") throw new CoordinationError("writer_not_active", record);
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
