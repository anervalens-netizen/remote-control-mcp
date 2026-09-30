import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { executionLabel } from "./execution-identity.ts";
import { correlationSchema, observationSchema, readEntry, saveEntry, type Entry, type WorkCorrelation } from "./contextkeep-journal.ts";
import { BridgeError, callContextKeep, categoryOf, object, type ErrorCategory } from "./contextkeep-transport.ts";
export type { WorkCorrelation } from "./contextkeep-journal.ts";

type Config = { directory: string; url: string; token: string };
type Caller = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
type Pending = Pick<Entry, "state" | "createdAt" | "nextAttemptAt" | "lastError"> & {
  saveRetry?: { attempts: number; at: number };
  runLookupOffset?: number;
};
const reconciliationInterval = 60_000;
const retryDelay = (attempts: number) => Math.min(300_000, 1000 * 2 ** Math.min(attempts, 9));
const terminal = new Set(["completed", "failed", "cancelled", "lost"]);
const uncertain = () => new Error("job_start_uncertain: retained reservation requires inspection; automatic replay is disabled.");
export function jobInputHash(input: { command: string; cwd?: string; env?: Record<string, string> }) {
  // Construct the canonical object text directly: integer-like object keys
  // are reordered by JSON.stringify even after Object.fromEntries(sorted).
  const entries = Object.entries(input.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const environment = entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",");
  const canonical = `{"command":${JSON.stringify(input.command)},"cwd":${JSON.stringify(input.cwd ?? null)},"env":{${environment}}}`;
  return createHash("sha256").update(canonical).digest("hex");
}
function checkRun(value: unknown, entry: Entry): Record<string, unknown> {
  if (!object(value) || value.id !== entry.correlation.runId || value.projectId !== entry.correlation.projectId ||
      value.taskId !== entry.correlation.taskId || value.externalJobId !== entry.jobId || value.device !== entry.device ||
      value.identity !== executionLabel(entry.target) || !Number.isInteger(value.revision) || Number(value.revision) < 1 ||
      typeof value.status !== "string" || !["running", ...terminal].includes(value.status) ||
      !["pending", "passed", "failed"].includes(String(value.verification)) ||
      (value.inputHash !== undefined && value.inputHash !== entry.hash)) throw new BridgeError("ack_mismatch");
  return value;
}
function observedStatus(entry: Entry) {
  const observation = entry.observed!;
  return observation.state === "completed" ? (observation.exitCode === 0 ? "completed" : "failed") : observation.state;
}
// Even an injected caller/executor that ignores cancellation cannot hold shutdown
// open. A late completion has no continuation that can mutate the journal.
async function bounded<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new BridgeError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([action(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class ContextKeepBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy: Promise<void> | undefined;
  private readonly shutdown = new AbortController();
  private readonly starting = new Set<Promise<unknown>>();
  private readonly call: Caller;
  private readonly client: AgentClient;
  private readonly config: Config;
  private readonly pending = new Map<string, Pending>();
  private readonly corrupt = new Set<string>();
  private nextReconciliationAt = 0;
  private journalError = false;
  constructor(client: AgentClient, config: Config, call?: Caller) {
    this.client = client; this.config = config;
    if (!path.isAbsolute(config.directory)) throw new Error("Bridge directory must be absolute.");
    const url = new URL(config.url);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid configured bridge endpoint.");
    if (url.protocol === "http:" && !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Bridge HTTP is loopback-only.");
    mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    this.call = call ?? ((name, args, signal) => callContextKeep(config, name, args, signal));
  }
  private save(entry: Entry, create = false) {
    try { saveEntry(this.config.directory, entry, create); }
    catch (error) { if (create) throw error; throw new BridgeError("journal"); }
    this.index(entry, true);
  }
  private keys() { return readdirSync(this.config.directory).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).sort().map(f => f.slice(0, -5)); }
  private index(entry: Entry, saved = false) {
    this.corrupt.delete(entry.key);
    if (entry.state === "delivered") this.pending.delete(entry.key);
    else this.pending.set(entry.key, {
      state: entry.state, createdAt: entry.createdAt, nextAttemptAt: entry.nextAttemptAt, lastError: entry.lastError,
      saveRetry: saved ? undefined : this.pending.get(entry.key)?.saveRetry,
      runLookupOffset: this.pending.get(entry.key)?.runLookupOffset,
    });
  }
  private read(key: string) {
    try {
      const entry = readEntry(this.config.directory, key);
      this.index(entry);
      return entry;
    } catch (error) {
      this.pending.delete(key); this.corrupt.add(key);
      throw error;
    }
  }
  private refreshIndex() {
    if (Date.now() < this.nextReconciliationAt) return;
    // Bootstrap, then reconcile on the next pump/diagnostic call 60s after
    // the previous scan finishes (even a slow or failed scan).
    // External additions, repairs and removals become visible without watchers
    // or retaining metadata for every permanent delivered tombstone. Local
    // successful writes and strict reads update diagnostics immediately.
    try {
      const keys = this.keys();
      this.journalError = false;
      const missing = new Set([...this.pending.keys(), ...this.corrupt]);
      for (const key of keys) {
        missing.delete(key);
        try { this.read(key); } catch { /* Keep corrupt evidence isolated. */ }
      }
      for (const key of missing) { this.pending.delete(key); this.corrupt.delete(key); }
    } catch { this.journalError = true; }
    finally { this.nextReconciliationAt = Date.now() + reconciliationInterval; }
  }
  start(device: string, target: AgentEndpointContext, input: { command: string; cwd?: string; env?: Record<string, string>; idempotencyKey?: string }, correlation: WorkCorrelation) {
    const pending = this.startOnce(device, target, input, correlation);
    this.starting.add(pending);
    void pending.then(() => this.starting.delete(pending), () => this.starting.delete(pending));
    return pending;
  }
  private async startOnce(device: string, target: AgentEndpointContext, input: { command: string; cwd?: string; env?: Record<string, string>; idempotencyKey?: string }, correlation: WorkCorrelation) {
    if (this.shutdown.signal.aborted) throw new BridgeError("cancelled");
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) throw new Error("Correlated jobs require a stable idempotencyKey.");
    if (!correlationSchema.safeParse(correlation).success || !device || device.length > 100 || !["user", "system", "desktop"].includes(target)) throw new Error("Invalid bridge correlation scope.");
    const key = createHash("sha256").update(JSON.stringify([device, target, input.idempotencyKey])).digest("hex"), hash = jobInputHash(input);
    const entry: Entry = {
      version: 2, key, hash, device, target, correlation, state: "job_start_uncertain", attachKey: randomUUID(), observeKey: randomUUID(),
      attachAcknowledged: false, createdAt: Date.now(), attempts: 0, nextAttemptAt: 0,
    };
    try { this.save(entry, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw uncertain();
      let prior: Entry;
      try { prior = this.read(key); } catch { throw uncertain(); }
      if (prior.device !== device || prior.target !== target) throw uncertain();
      if (prior.hash !== hash || Object.keys(correlation).some(k => prior.correlation[k as keyof WorkCorrelation] !== correlation[k as keyof WorkCorrelation])) throw new Error("contextkeep_job_conflict");
      if (!prior.jobId) throw uncertain();
      return bounded(() => this.client.jobStatus(device, prior.jobId!, target, { signal: this.shutdown.signal }), this.shutdown.signal);
    }
    // Durable exclusive reservation precedes the only executor start. A lost
    // receipt or failed persistence never permits replay, including after restart.
    let result: unknown;
    try {
      result = await bounded(() => this.client.jobStart(device, input, target, { signal: this.shutdown.signal }), this.shutdown.signal);
    } catch { throw uncertain(); }
    // Aborting the request does not prove the executor did not start it. Keep
    // the durable uncertain reservation; a late receipt must not mutate it.
    if (this.shutdown.signal.aborted) throw uncertain();
    if (!object(result) || typeof result.id !== "string" || !result.id || result.id.length > 200) throw uncertain();
    entry.jobId = result.id; entry.state = "tracking";
    try { this.save(entry); } catch { throw uncertain(); }
    return result;
  }
  private async taskRun(entry: Entry, signal: AbortSignal): Promise<Record<string, unknown>> {
    // Bound one attempt, not the entire task's searchable history. Keep the
    // cursor only with unresolved in-memory work; restart safely rescans from 0
    // without changing durable reservation or acknowledgement contracts.
    const startOffset = this.pending.get(entry.key)?.runLookupOffset ?? 0;
    for (let page = 0, offset = startOffset; page < 10; page++, offset += 50) {
      const view = await bounded(() => this.call("get_task", { projectId: entry.correlation.projectId, taskId: entry.correlation.taskId, offset, limit: 50 }, signal), signal);
      // publicRun carries explicit project/task scope; do not depend on the
      // separate task dossier's internal record representation for correlation.
      if (!object(view) || !object(view.task) ||
          !Array.isArray(view.runs) || view.runs.length > 50 || !object(view.pagination) || !Number.isInteger(view.pagination.totalRuns) || Number(view.pagination.totalRuns) < 0 ||
          view.pagination.offset !== offset || view.pagination.limit !== 50) throw new BridgeError("invalid_response");
      const matches = view.runs.filter(run => object(run) && run.id === entry.correlation.runId);
      if (matches.length > 1) throw new BridgeError("invalid_response");
      const pending = this.pending.get(entry.key);
      if (matches.length === 1) {
        const run = checkRun(matches[0], entry);
        if (pending) pending.runLookupOffset = 0;
        return run;
      }
      const exhausted = offset + 50 >= Number(view.pagination.totalRuns);
      if (pending) pending.runLookupOffset = exhausted ? 0 : offset + 50;
      if (exhausted) break;
    }
    throw new BridgeError("proof_missing");
  }
  private async deliver(entry: Entry, signal: AbortSignal) {
    const scope = { projectId: entry.correlation.projectId, taskId: entry.correlation.taskId, runId: entry.correlation.runId, clientId: "remote-control", sessionId: "executor-bridge" };
    let remote: Record<string, unknown> | undefined;
    if (!entry.attachAcknowledged) {
      try {
        const ack = await bounded(() => this.call("attach_run_job", { ...scope, leaseToken: entry.correlation.leaseToken, externalJobId: entry.jobId, inputHash: entry.hash, idempotencyKey: entry.attachKey }, signal), signal);
        remote = checkRun(object(ack) ? ack.run : undefined, entry);
        // attach_run_job validates inputHash server-side, although publicRun
        // redacts it. Persist this ACK before any observation or reconciliation.
        entry.attachAcknowledged = true;
        this.save(entry);
      } catch (error) {
        if (signal.aborted) throw error;
        // A stale lease may conceal a completed remote run. The read contract
        // redacts inputHash, so without our durable attach ACK this is NOT proof.
        const remote = await this.taskRun(entry, signal);
        if (terminal.has(String(remote.status))) throw new BridgeError("proof_missing");
        throw error;
      }
    }
    remote ??= await this.taskRun(entry, signal);
    if (this.reconcile(entry, remote)) return;
    if (!entry.observed) {
      let status: unknown;
      try { status = await bounded(() => this.client.jobStatus(entry.device, entry.jobId!, entry.target, { signal }), signal); }
      catch { throw new BridgeError(signal.aborted ? "cancelled" : "executor"); }
      if (!object(status) || status.id !== entry.jobId || typeof status.state !== "string") throw new BridgeError("executor");
      if (!["completed", "cancelled", "lost"].includes(status.state)) {
        if (!["running", "cancelling"].includes(status.state)) throw new BridgeError("executor");
        return;
      }
      const observation = observationSchema.safeParse({ state: status.state, exitCode: status.exitCode ?? null, finishedAt: status.finishedAt });
      if (!observation.success) throw new BridgeError("executor");
      // Never invent a timestamp or terminal fact when the executor omits it.
      entry.observed = observation.data;
      this.save(entry);
      // Refresh after executor I/O before considering a write to this run.
      remote = await this.taskRun(entry, signal);
      if (this.reconcile(entry, remote)) return;
    }
    if (entry.observed.state === "completed" && entry.observed.exitCode === null) throw new BridgeError("proof_missing");
    if (remote.verification !== "pending") throw new BridgeError("remote_conflict");
    // get_task has no revision fence for observe_run. This avoids writes to
    // known terminal/verified runs; a concurrent verification race requires
    // an atomic guard in ContextKeep's write contract, not invented evidence.
    const ack = await bounded(() => this.call("observe_run", {
      ...scope, externalJobId: entry.jobId, device: entry.device, identity: executionLabel(entry.target), eventKey: entry.key,
      status: observedStatus(entry), exitCode: entry.observed!.exitCode, observedAt: entry.observed!.finishedAt, idempotencyKey: entry.observeKey,
    }, signal), signal);
    const acknowledgedRun = checkRun(object(ack) ? ack.run : undefined, entry);
    if (!object(ack) || !(ack.duplicate === true || (ack.duplicate === false && typeof ack.applied === "boolean" &&
        z.string().uuid().safeParse(ack.observationId).success)) || !terminal.has(String(acknowledgedRun.status)) ||
        acknowledgedRun.status !== observedStatus(entry)) throw new BridgeError("ack_mismatch");
    entry.state = "delivered";
    this.save(entry); // Delivered tombstones are permanent deduplication records.
  }
  private reconcile(entry: Entry, remote: Record<string, unknown>): boolean {
    if (!terminal.has(String(remote.status))) return false;
    if (!entry.attachAcknowledged) throw new BridgeError("proof_missing");
    if (entry.observed && (entry.observed.state === "completed" && entry.observed.exitCode === null || remote.status !== observedStatus(entry))) throw new BridgeError("remote_conflict");
    // Exact scope/job/device/identity plus the persisted hash-checked attach
    // proves this run. No invented observation is needed if executor metadata
    // has expired: the remote terminal receipt already covers this execution.
    entry.state = "delivered";
    this.save(entry);
    return true;
  }
  private async process(key: string) {
    const scheduled = this.pending.get(key);
    if (!scheduled || scheduled.state !== "tracking" || Math.max(scheduled.nextAttemptAt, scheduled.saveRetry?.at ?? 0) > Date.now()) return;
    let entry: Entry;
    try { entry = this.read(key); } catch { return; } // Strict disk read before acting, never cached ACK proof.
    if (entry.state !== "tracking" || entry.nextAttemptAt > Date.now() || this.shutdown.signal.aborted) return;
    entry.attempts = Math.max(entry.attempts, scheduled.saveRetry?.attempts ?? 0);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000);
    const signal = AbortSignal.any([this.shutdown.signal, deadline.signal]);
    try {
      await this.deliver(entry, signal);
      entry.attempts = 0; delete entry.lastError; entry.nextAttemptAt = Date.now() + 2000;
    } catch (error) {
      entry.attempts = Math.min(30, entry.attempts + 1);
      entry.lastError = deadline.signal.aborted ? "timeout" : categoryOf(error);
      entry.nextAttemptAt = Date.now() + retryDelay(entry.attempts);
    } finally { clearTimeout(timer); }
    try { this.save(entry); } catch {
      // A failed save cannot evict pending work or promote in-memory ACKs.
      // Retain the last durable stage and back off even if the retry deadline
      // itself could not be persisted. Reconciliation must retain this delay.
      const retained = this.pending.get(key);
      if (retained) {
        const attempts = Math.min(30, Math.max(entry.attempts, (scheduled.saveRetry?.attempts ?? 0) + 1));
        retained.saveRetry = { attempts, at: Date.now() + retryDelay(attempts) };
      }
    }
  }
  pump(): Promise<void> {
    if (this.shutdown.signal.aborted) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = (async () => {
      this.refreshIndex();
      const keys = [...this.pending.keys()]; let next = 0;
      // Slow/corrupt entries cannot serially starve healthy receipts.
      await Promise.all(Array.from({ length: Math.min(4, keys.length) }, async () => {
        while (!this.shutdown.signal.aborted) {
          const key = keys[next++]; if (key === undefined) break;
          await this.process(key);
        }
      }));
    })().finally(() => { this.busy = undefined; });
    return this.busy;
  }
  diagnostics() {
    this.refreshIndex();
    let oldestPendingMs = 0;
    const lastErrorCategories: Partial<Record<ErrorCategory, number>> = {};
    for (const entry of this.pending.values()) {
      oldestPendingMs = Math.max(oldestPendingMs, Date.now() - entry.createdAt);
      const error = entry.saveRetry ? "journal" : entry.lastError;
      if (error) lastErrorCategories[error] = (lastErrorCategories[error] ?? 0) + 1;
    }
    if (this.journalError) lastErrorCategories.journal = (lastErrorCategories.journal ?? 0) + 1;
    return { pendingCount: this.pending.size, oldestPendingMs, lastErrorCategories, corruptCount: this.corrupt.size };
  }
  startWorker() {
    if (this.timer || this.shutdown.signal.aborted) return;
    this.timer = setInterval(() => { void this.pump().catch(() => {}); }, 2000);
    this.timer.unref();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.shutdown.abort();
    await Promise.allSettled([...this.starting, ...(this.busy ? [this.busy] : [])]);
  }
}
const instances = new WeakMap<AgentClient, ContextKeepBridge>();
const active = new Set<ContextKeepBridge>();
export function contextKeepBridgeDiagnostics(client: AgentClient) { return instances.get(client)?.diagnostics(); }
export function configuredContextKeepBridge(client: AgentClient) {
  const prior = instances.get(client); if (prior) return prior;
  const directory = process.env.RCMCP_CONTEXTKEEP_STATE_DIR, url = process.env.RCMCP_CONTEXTKEEP_URL, token = process.env.RCMCP_CONTEXTKEEP_TOKEN;
  if (!directory || !url || !token) return undefined;
  const bridge = new ContextKeepBridge(client, { directory, url, token });
  instances.set(client, bridge); active.add(bridge); bridge.startWorker(); return bridge;
}
export async function closeContextKeepBridges() { await Promise.all([...active].map(b => b.close())); active.clear(); }
