import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { executionOutcome } from "../../../packages/protocol/src/execution-outcome.ts";
import { correlationHash } from "../../../packages/protocol/src/diagnostic-context.ts";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";

const identity = z.enum(["owner", "root", "interactive"]);
const contextKeepReference = z.object({ projectId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid() });
export const jobReferenceSchema = z.object({ device: z.string().max(256), identity, jobId: z.string().min(1).max(256) }).strict();
export type JobReference = z.infer<typeof jobReferenceSchema>;
const eventSchema = z.object({ stage: z.enum(["handler_started", "agent_dispatch", "agent_response", "handler_returned"]), at: z.string().datetime(), device: z.string().max(256).optional(), identity: identity.optional(), successful: z.boolean().optional() }).strict();
const operationSchema = z.object({
  version: z.literal(1), traceId: z.string().uuid(), controllerInstanceId: z.string().uuid(), tool: z.string().max(128),
  diagnosticScopeId: z.string().uuid().optional(), requestHash: z.string().length(64).optional(), sessionHash: z.string().length(64).optional(),
  contextKeep: contextKeepReference.optional(),
  startedAt: z.string().datetime(), updatedAt: z.string().datetime(), state: z.enum(["running", "returned", "unknown"]),
  events: z.array(eventSchema).max(128), eventsPartial: z.boolean(), jobs: z.array(jobReferenceSchema).max(64), jobsPartial: z.boolean(),
  requestSucceeded: z.boolean().optional(), executionOutcome: z.string().max(32).optional(), exitCode: z.number().int().nullable().optional(),
  callerDisconnected: z.boolean().optional(), clientAcceptance: z.literal("unknown"), effectVerification: z.literal("unverified"),
  recoveryId: z.string().uuid().optional(),
}).strict();
export type ObservedOperation = z.infer<typeof operationSchema>;
type CurrentOperation = { observer: OperationObserver; traceId: string };
export const operationContext = new AsyncLocalStorage<CurrentOperation>();
export const consoleReadTools = new Set(["open_remote_control_console", "dashboard_snapshot", "operation_inspect"]);

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
      for (const file of files) {
        if (!/^[a-f0-9-]{36}\.json$/.test(file)) { this.faults.add("unrecognized_journal_entry"); continue; }
        const stat = await fs.lstat(path.join(this.directory, file));
        this.totalBytes += stat.size;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || this.entries.size >= this.maxEntries || this.totalBytes > this.maxBytes) { this.faults.add("journal_capacity_or_invalid_entry"); continue; }
        try {
          const record = operationSchema.parse(JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8")));
          if (`${record.traceId}.json` !== file) throw new Error("reference mismatch");
          if (record.state === "running") record.state = "unknown";
          this.entries.set(record.traceId, record);
          this.sizes.set(record.traceId, stat.size);
        } catch { this.faults.add("journal_corrupt"); }
      }
    } catch { this.faults.add("journal_unavailable"); }
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(action).catch(() => { this.faults.add("journal_write_failed"); });
    return this.queue;
  }
  private async prune() {
    for (const [id, record] of this.entries) {
      if (record.state !== "returned" || Date.now() - Date.parse(record.updatedAt) < this.retentionMs) continue;
      if (this.directory) await fs.unlink(path.join(this.directory, `${id}.json`));
      this.entries.delete(id);
      this.totalBytes -= this.sizes.get(id) ?? 0;
      this.sizes.delete(id);
    }
  }
  private async save(record: ObservedOperation) {
    const json = JSON.stringify(operationSchema.parse(record));
    const bytes = Buffer.byteLength(json);
    const previous = this.sizes.get(record.traceId) ?? 0;
    if (bytes > 64 * 1024 || this.totalBytes - previous + bytes > this.maxBytes) { this.faults.add("journal_capacity"); return false; }
    this.totalBytes += bytes - previous;
    this.sizes.set(record.traceId, bytes);
    this.entries.set(record.traceId, record);
    if (this.directory) {
      if (!path.isAbsolute(this.directory)) throw new Error("absolute directory required");
      const file = path.join(this.directory, `${record.traceId}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(json);
        await handle.sync();
        await handle.close(); handle = undefined;
        await fs.rename(temporary, file);
        if (process.platform !== "win32") {
          const directory = await fs.open(this.directory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
    }
    return true;
  }
  async begin(tool: string, scope: unknown, requestId?: unknown, sessionId?: unknown, workflow?: unknown): Promise<string | undefined> {
    await this.ready;
    let id: string | undefined;
    await this.serialize(async () => {
      await this.prune();
      if (this.entries.size >= this.maxEntries || this.totalBytes >= this.maxBytes) { this.faults.add("journal_capacity"); return; }
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
      if (await this.save(record) === false) id = undefined;
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
        if (record.jobs.length < 64) record.jobs.push(jobReferenceSchema.parse(job)); else record.jobsPartial = true;
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
      if (recoveryId) record.recoveryId = recoveryId;
      if (record.events.length < 128) record.events.push({ stage: "handler_returned", at: record.updatedAt }); else record.eventsPartial = true;
      await this.save(record);
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
    const selected = remaining.slice(0, limit);
    const last = selected.at(-1);
    return { controllerInstanceId: this.controllerInstanceId, observedAt: new Date().toISOString(),
      items: selected.map(({ events, jobs, ...r }) => ({ ...structuredClone(r), jobs: structuredClone(jobs.slice(0, 3)), jobsPreview: jobs.length > 3, jobCount: jobs.length, eventCount: events.length })),
      nextCursor: remaining.length > selected.length && last ? Buffer.from(JSON.stringify({ at: last.startedAt, id: last.traceId })).toString("base64url") : null,
      coverage: { partial: this.faults.size > 0, faults: [...this.faults], persistence: this.directory ? "metadata_journal" : "controller_memory", scope: "Observed handler calls only; association is client-declared; job state must be read from its agent.", totalKnown: this.entries.size } };
  }
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
