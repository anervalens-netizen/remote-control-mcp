import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { executionOutcome } from "../../../packages/protocol/src/execution-outcome.ts";
import { correlationHash } from "../../../packages/protocol/src/diagnostic-context.ts";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";

// Explicit read-only contracts; never infer effect safety from an error code.
const readOnlyOperations = new Set(["android_observe", "android_command_status", "batch_recover", "pty_output", "search_results", "search_status", "exec_recover", "fs_read", "fs_list", "batch_read", "job_status", "job_output", "job_output_since", "job_wait", "job_list", "job_history", "job_lineage", "device_info", "device_contexts", "devices_list", "service_inspect", "service_logs", "network_snapshot", "android_status"]);
const identity = z.enum(["owner", "root", "interactive"]);
const contextKeepReference = z.object({ projectId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid() });
export const jobReferenceSchema = z.object({ device: z.string().max(256), identity, jobId: z.string().min(1).max(256) }).strict();
export type JobReference = z.infer<typeof jobReferenceSchema>;
const sameJob = (a: JobReference, b: JobReference) => a.device === b.device && a.identity === b.identity && a.jobId === b.jobId;
const eventSchema = z.object({ stage: z.enum(["handler_started", "agent_dispatch", "agent_response", "handler_returned"]), at: z.string().datetime(), device: z.string().max(256).optional(), identity: identity.optional(), successful: z.boolean().optional() }).strict();
const operationSchema = z.object({
  version: z.literal(1), traceId: z.string().uuid(), controllerInstanceId: z.string().uuid(), tool: z.string().max(128),
  diagnosticScopeId: z.string().uuid().optional(), requestHash: z.string().length(64).optional(), sessionHash: z.string().length(64).optional(),
  contextKeep: contextKeepReference.optional(),
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["running", "returned", "unknown"]),
  terminalJobs: z.array(jobReferenceSchema).max(64).optional(),
  events: z.array(eventSchema).max(128), eventsPartial: z.boolean(), jobs: z.array(jobReferenceSchema).max(64), jobsPartial: z.boolean(),
  requestSucceeded: z.boolean().optional(), executionOutcome: z.string().max(32).optional(), exitCode: z.number().int().nullable().optional(),
  callerDisconnected: z.boolean().optional(), clientAcceptance: z.literal("unknown"), effectVerification: z.literal("unverified"),
  recoveryId: z.string().uuid().optional(),
  failure: z.object({ kind: z.string().max(64).optional(), agentCode: z.string().max(64).optional(), status: z.number().int().optional() }).strict().optional(),
  terminationReason: z.string().max(128).optional(),
  terminationVerified: z.boolean().optional(),
  persistence: z.enum(["confirmed", "unconfirmed"]).optional(),
}).strict();
export type ObservedOperation = z.infer<typeof operationSchema>;
type CurrentOperation = { observer: OperationObserver; traceId: string };
export const operationContext = new AsyncLocalStorage<CurrentOperation>();
export const consoleReadTools = new Set(["open_remote_control_console", "dashboard_snapshot", "operation_inspect"]);
const coverageFileSchema = z.object({
  faults: z.array(z.enum(["coverage_persistence_failed", "coverage_unavailable", "unrecognized_journal_entry", "journal_capacity_or_invalid_entry", "journal_corrupt", "temporary_reconciliation_required", "journal_unavailable", "journal_write_failed", "journal_capacity", "journal_update_over_budget"])).max(10),
  counters: z.object({ admissionRefused: z.number().int().nonnegative().safe(), persistenceFailures: z.number().int().nonnegative().safe(), compacted: z.number().int().nonnegative().safe(), evicted: z.number().int().nonnegative().safe(), recoveredTemporaries: z.number().int().nonnegative().safe() }).strict(),
}).strict();

/** An additive metadata index, not an executor or a replacement for job journals.
 * Every write is bounded and failure is reported as partial coverage, never as
 * a reason to fail/replay the user's operation. One controller owns a directory.
 */
export class OperationObserver {
  readonly controllerInstanceId = randomUUID();
  private readonly entries = new Map<string, ObservedOperation>();
  private readonly sizes = new Map<string, number>();
  private readonly faults = new Set<string>();
  private totalBytes = 0;
  private untrackedBytes = 0;
  private counters = { admissionRefused: 0, persistenceFailures: 0, compacted: 0, evicted: 0, recoveredTemporaries: 0 };
  private canRetire(record: ObservedOperation) {
    const returned = record.state === "returned" || record.events.some(e => e.stage === "handler_returned") &&
      ["job_wait", "job_status", "job_output", "job_output_since"].includes(record.tool);
    const needsLocator = ["job_start", "job_start_many", "project_run", "deploy_run", "batch_exec", "process_start", "pty_start"].includes(record.tool);
    return record.persistence !== "unconfirmed" && returned && (!needsLocator || record.jobs.length > 0 || !record.events.some(e => e.stage === "agent_dispatch")) && !record.jobsPartial && record.jobs.every(job => record.terminalJobs?.some(t => sameJob(job, t))) &&
      (record.jobs.length > 0 || record.requestSucceeded === true || readOnlyOperations.has(record.tool) || !record.events.some(e => e.stage === "agent_dispatch"));
  }
  private async remove(id: string) {
    if (this.directory) await fs.unlink(path.join(this.directory, `${id}.json`)).catch(error => { if (error.code !== "ENOENT") throw error; });
    this.entries.delete(id); this.totalBytes -= this.sizes.get(id) ?? 0; this.sizes.delete(id);
  }
  private async capacity(bytes: number, exclude?: string) {
    for (const [id, record] of [...this.entries].sort((a,b) => a[1].updatedAt.localeCompare(b[1].updatedAt))) {
      if (this.entries.size < this.maxEntries && this.totalBytes + bytes <= this.maxBytes) break;
      if (id === exclude || !this.canRetire(record)) continue;
      await this.remove(id); this.counters.evicted++;
    }
  }
  private async saveHealth() {
    if (!this.directory) return;
    const file = path.join(this.directory, "coverage.json");
    const temporary = `${file}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ faults: [...this.faults], counters: this.counters }), { mode: 0o600 });
      await fs.rename(temporary, file);
    } catch { this.faults.add("coverage_persistence_failed"); }
  }
  coverage(id?: string) {
    return { partial: this.faults.size > 0 || id !== undefined && this.entries.get(id)?.persistence === "unconfirmed",
      faults: [...this.faults], counters: { ...this.counters }, totalKnown: this.entries.size, retainedBytes: this.totalBytes, untrackedBytes: this.untrackedBytes,
      maxEntries: this.maxEntries, maxBytes: this.maxBytes, saturated: this.entries.size >= this.maxEntries || this.totalBytes >= this.maxBytes,
      persistence: this.directory ? "metadata_journal" : "controller_memory",
      ...(id ? { observationPersistence: this.entries.get(id)?.persistence ?? "unconfirmed" } : {}),
      scope: "Observed handler calls only; association is client-declared; job state must be read from its agent." };
  }
  private queue: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  readonly directory: string | undefined;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly retentionMs: number;
  constructor(directory?: string, maxEntries = 5000, maxBytes = 16 * 1024 * 1024, retentionMs = 7 * 86400_000) {
    this.directory = directory; this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.retentionMs = retentionMs;
    this.ready = this.load();
  }
  private async load() {
    if (!this.directory) return;
    try {
      if (!path.isAbsolute(this.directory)) throw new Error("absolute directory required");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const files = await fs.readdir(this.directory);
      try {
        const file = path.join(this.directory, "coverage.json");
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("invalid coverage file");
        const handle = await fs.open(file, "r");
        let saved;
        try {
          const buffer = Buffer.alloc(16385);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 16384) throw new Error("coverage file too large");
          saved = coverageFileSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
        } finally { await handle.close(); }
        for (const fault of saved.faults) this.faults.add(fault);
        this.counters = saved.counters;
      } catch (error: any) { if (error.code !== "ENOENT") this.faults.add("coverage_unavailable"); }
      const temporaries: string[] = [];
      for (const file of files) {
        if (file === "coverage.json" || file === "coverage.json.tmp") continue;
        if (/^[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/.test(file)) { temporaries.push(file); continue; }
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) { this.faults.add("unrecognized_journal_entry"); continue; }
        const stat = await fs.lstat(path.join(this.directory, file));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 || this.entries.size >= this.maxEntries) { this.untrackedBytes += stat.size; this.faults.add("journal_capacity_or_invalid_entry"); continue; }
        try {
          const record = operationSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")));
          if (`${record.traceId}.json` !== file) throw new Error("reference mismatch");
          if (record.state === "running") record.state = "unknown";
          record.persistence = "confirmed";
          this.entries.set(record.traceId, record);
          this.sizes.set(record.traceId, stat.size);
          this.totalBytes += stat.size;
        } catch { this.untrackedBytes += stat.size; this.faults.add("journal_corrupt"); }
      }
      // A fsynced temporary may contain the only job locator. Merge references
      // conservatively before replacing/removing anything, never infer execution.
      for (const file of temporaries) {
        try {
          const location = path.join(this.directory, file);
          const stat = await fs.lstat(location);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error("invalid temporary");
          const candidate = operationSchema.parse(JSON.parse(await fs.readFile(location, "utf8")));
          if (!file.startsWith(`${candidate.traceId}.json.`)) throw new Error("reference mismatch");
          const original = this.entries.get(candidate.traceId);
          const merged = structuredClone(original ?? candidate);
          let overflow = false;
          for (const job of candidate.jobs) if (!merged.jobs.some(j => sameJob(j, job))) {
            if (merged.jobs.length < 64) merged.jobs.push(job); else { merged.jobsPartial = true; overflow = true; }
          }
          for (const terminal of candidate.terminalJobs ?? []) {
            merged.terminalJobs ??= [];
            if (merged.jobs.some(j => sameJob(j, terminal)) && !merged.terminalJobs.some(j => sameJob(j, terminal))) merged.terminalJobs.push(terminal);
          }
          merged.jobsPartial ||= candidate.jobsPartial;
          merged.recoveryId ??= candidate.recoveryId;
          merged.state = "unknown";
          merged.persistence = "unconfirmed";
          if (!original && this.entries.size >= this.maxEntries) throw new Error("capacity");
          if (await this.save(merged) === false || overflow) throw new Error("temporary requires retained capacity");
          await fs.unlink(location); this.counters.recoveredTemporaries++;
        } catch { this.faults.add("temporary_reconciliation_required"); }
      }
    } catch { this.faults.add("journal_unavailable"); }
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(action).catch(() => { this.faults.add("journal_write_failed"); this.counters.persistenceFailures++; }).then(() => this.saveHealth());
    return this.queue;
  }
  private async prune() {
    for (const [id, record] of this.entries) {
      if (!this.canRetire(record) || Date.now() - Date.parse(record.updatedAt) < this.retentionMs) continue;
      await this.remove(id);
    }
  }
  private async save(record: ObservedOperation) {
    record.persistence = this.directory ? "unconfirmed" : "confirmed";
    let json = JSON.stringify(operationSchema.parse({ ...record, persistence: "confirmed" }));
    let bytes = Buffer.byteLength(json);
    const previous = this.sizes.get(record.traceId) ?? 0;
    if (bytes > 512 * 1024 || this.totalBytes - previous + bytes > this.maxBytes) {
      // Events are diagnostic detail; locators and completion are essential.
      record.events = record.events.filter((e, i, all) => i === 0 || e.stage === "handler_returned" || i === all.length - 1);
      record.eventsPartial = true; this.counters.compacted++;
      json = JSON.stringify(operationSchema.parse({ ...record, persistence: "confirmed" })); bytes = Buffer.byteLength(json);
      await this.capacity(Math.max(0, bytes - previous), record.traceId);
    }
    if (bytes > 512 * 1024 || !this.entries.has(record.traceId) && this.totalBytes + bytes > this.maxBytes) {
      this.faults.add("journal_capacity"); return false;
    }
    // maxBytes is an admission budget. Updates to admitted bounded records must
    // not discard effects already observed. Hard bound remains maxEntries*512KiB.
    if (this.totalBytes - previous + bytes > this.maxBytes) this.faults.add("journal_update_over_budget");
    this.totalBytes += bytes - previous;
    this.sizes.set(record.traceId, bytes);
    this.entries.set(record.traceId, record);
    if (this.directory) {
      if (!path.isAbsolute(this.directory)) throw new Error("absolute directory required");
      const file = path.join(this.directory, `${record.traceId}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      let synchronized = false, published = false;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(json);
        await handle.sync(); synchronized = true;
        await handle.close(); handle = undefined;
        await fs.rename(temporary, file); published = true;
        if (process.platform !== "win32") {
          const directory = await fs.open(this.directory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally {
        await handle?.close();
        // A synchronized temporary may be the only durable locator. Preserve it
        // on publication failure for validated reconciliation at reload.
        if (published || !synchronized && handle) await fs.unlink(temporary).catch(() => {});
      }
    }
    record.persistence = "confirmed";
    return true;
  }
  async begin(tool: string, scope: unknown, requestId?: unknown, sessionId?: unknown, workflow?: unknown): Promise<string | undefined> {
    await this.ready;
    let id: string | undefined;
    await this.serialize(async () => {
      await this.prune();
      await this.capacity(1024);
      if (this.entries.size >= this.maxEntries || this.totalBytes >= this.maxBytes) { this.faults.add("journal_capacity"); this.counters.admissionRefused++; return; }
      const scopeResult = z.string().uuid().safeParse(scope);
      const workflowResult = contextKeepReference.safeParse(workflow);
      const at = new Date().toISOString();
      const record: ObservedOperation = { version: 1, traceId: randomUUID(), controllerInstanceId: this.controllerInstanceId, tool,
        ...(scopeResult.success ? { diagnosticScopeId: scopeResult.data } : {}),
        ...(workflowResult.success ? { contextKeep: workflowResult.data } : {}),
        ...(requestId === undefined ? {} : { requestHash: correlationHash(requestId) }),
        ...(sessionId === undefined ? {} : { sessionHash: correlationHash(sessionId) }),
        startedAt: at, updatedAt: at, state: "running", events: [{ stage: "handler_started", at }], eventsPartial: false, jobs: [], jobsPartial: false,
        clientAcceptance: "unknown", effectVerification: "unverified" };
      id = record.traceId;
      if (await this.save(record) === false) { id = undefined; this.counters.admissionRefused++; }
    });
    return id;
  }
  async event(id: string, event: Omit<z.infer<typeof eventSchema>, "at">, job?: JobReference) {
    await this.serialize(async () => {
      const original = this.entries.get(id); if (!original) return;
      const record = structuredClone(original);
      record.updatedAt = new Date().toISOString();
      if (record.events.length < 128) record.events.push({ ...event, at: record.updatedAt }); else record.eventsPartial = true;
      if (job && !record.jobs.some(j => j.device === job.device && j.identity === job.identity && j.jobId === job.jobId)) {
        if (record.jobs.length < 64) {
          record.jobs.push(jobReferenceSchema.parse(job));
          // Job IDs are immutable. Carry already observed terminal evidence to
          // later output reads; EOF alone never creates such evidence.
          if ([...this.entries.values()].some(row => row.terminalJobs?.some(terminal => sameJob(job, terminal)))) {
            (record.terminalJobs ??= []).push(jobReferenceSchema.parse(job));
          }
        } else record.jobsPartial = true;
      }
      await this.save(record);
    });
  }
  async finish(id: string, result: Record<string, unknown> | undefined, requestSucceeded: boolean, disconnected: boolean, recoveryId?: string) {
    await this.serialize(async () => {
      const original = this.entries.get(id); if (!original) return;
      const record = structuredClone(original);
      record.updatedAt = new Date().toISOString(); record.state = "returned";
      record.requestSucceeded = requestSucceeded; record.callerDisconnected = disconnected;
      if (record.tool === "exec" && result) { record.executionOutcome = executionOutcome(result); if (typeof result.code === "number" || result.code === null) record.exitCode = result.code; }
      if (result) {
        const safeCode = (v: unknown, max: number) => typeof v === "string" && v.length <= max && /^[a-zA-Z0-9_]+$/.test(v) ? v : undefined;
        const kind = safeCode(result.kind, 64), agentCode = safeCode(result.agentCode, 64);
        const status = typeof result.status === "number" && Number.isInteger(result.status) ? result.status : undefined;
        if (!requestSucceeded) record.failure = { ...(kind ? { kind } : {}), ...(agentCode ? { agentCode } : {}), ...(status === undefined ? {} : { status }) };
        const reason = safeCode(result.terminationReason, 128);
        if (reason) record.terminationReason = reason;
        if (typeof result.terminationVerified === "boolean") record.terminationVerified = result.terminationVerified;
      }
      // A failed/disconnected call can leave effects running after dispatch.
      // Preserve that uncertainty independently of the handler-return event.
      if (record.executionOutcome === "uncertain" || (result?.timedOut === true && result.terminationVerified !== true) ||
          ((!requestSucceeded || disconnected) && !readOnlyOperations.has(record.tool) && record.events.some(event => event.stage === "agent_dispatch"))) record.state = "unknown";
      if (recoveryId) record.recoveryId = recoveryId;
      if (!record.events.some(event => event.stage === "handler_returned")) {
        if (record.events.length < 128) record.events.push({ stage: "handler_returned", at: record.updatedAt }); else record.eventsPartial = true;
      }
      await this.save(record);
    });
  }
  /** Only a fresh agent status may establish that a referenced job is terminal. */
  async reconcileJob(job: JobReference, state: unknown) {
    await this.ready;
    if (!["running", "cancelling", "completed", "cancelled", "lost"].includes(String(state))) return;
    await this.serialize(async () => {
      for (const original of this.entries.values()) {
        if (!original.jobs.some(candidate => sameJob(candidate, job))) continue;
        const record = structuredClone(original);
        // Terminal evidence for an immutable job identity is monotonic: a stale
        // response arriving later cannot make a completed job active again.
        if (state !== "completed" && state !== "cancelled") continue;
        record.terminalJobs ??= [];
        if (!record.terminalJobs.some(candidate => sameJob(candidate, job))) record.terminalJobs.push(jobReferenceSchema.parse(job));
        if (record.state === "unknown" && ["job_wait", "job_status", "job_output", "job_output_since"].includes(record.tool) &&
            record.events.some(event => event.stage === "handler_returned") && !record.jobsPartial &&
            record.jobs.every(j => record.terminalJobs!.some(t => sameJob(j, t)))) record.state = "returned";
        await this.save(record);
      }
    });
  }
  async snapshot(input: { diagnosticScopeId?: string; cursor?: string; limit?: number } = {}) {
    await this.ready; await this.queue;
    const rows = [...this.entries.values()].filter(r => !input.diagnosticScopeId || r.diagnosticScopeId === input.diagnosticScopeId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.traceId.localeCompare(a.traceId));
    const limit = Math.min(50, Math.max(1, input.limit ?? 25));
    let after: { at: string; id: string } | undefined;
    if (input.cursor) after = z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
    const remaining = after ? rows.filter(r => r.startedAt < after.at || r.startedAt === after.at && r.traceId < after.id) : rows;
    // A row count alone is not a wire-size bound. Keep exact reference/cursor
    // identity while previewing metadata that is available through inspect.
    const selected: ObservedOperation[] = [];
    const previews: Record<string, unknown>[] = [];
    let pageBytes = 0;
    for (const row of remaining.slice(0, limit)) {
      const { events, jobs, terminalJobs, ...r } = row;
      const preview = { ...structuredClone(r), jobs: structuredClone(jobs.slice(0, 3)),
        jobsPreview: jobs.length > 3, jobCount: jobs.length, eventCount: events.length,
        terminalJobCount: terminalJobs?.length ?? 0 };
      const bytes = Buffer.byteLength(JSON.stringify(preview));
      if (selected.length && pageBytes + bytes > 24 * 1024) break;
      selected.push(row); previews.push(preview); pageBytes += bytes;
    }
    const last = selected.at(-1);
    return { controllerInstanceId: this.controllerInstanceId, observedAt: new Date().toISOString(),
      items: previews,
      nextCursor: remaining.length > selected.length && last ? Buffer.from(JSON.stringify({ at: last.startedAt, id: last.traceId })).toString("base64url") : null,
      coverage: this.coverage() };
  }
  async health() { await this.ready; await this.queue; return this.coverage(); }
  async inspect(id: string) { await this.ready; await this.queue; return structuredClone(this.entries.get(id) ?? null); }
}

const observers = new WeakMap<object, OperationObserver>();
export function operationsFor(client: AgentClient) {
  let observer = observers.get(client);
  if (!observer) {
    const root = process.env.RCMCP_STATE_DIR;
    observer = new OperationObserver(root ? path.join(root, "operation-observations-v1") : undefined);
    observers.set(client, observer);
  }
  return observer;
}
export async function observeAgent(stage: "agent_dispatch" | "agent_response", device: string, context: AgentEndpointContext, successful?: boolean, jobId?: string) {
  const current = operationContext.getStore(); if (!current) return;
  const selected = context === "system" ? "root" : context === "user" ? "owner" : "interactive";
  await current.observer.event(current.traceId, { stage, device, identity: selected, ...(successful === undefined ? {} : { successful }) },
    jobId ? { device, identity: selected, jobId } : undefined);
}
