import { jobStartFingerprint } from "../../agent/src/job-start-dedup.ts";
import { measureSync, measureAsync } from "../../../packages/protocol/src/diagnostic-context.ts";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, mkdirSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../agent/src/state.ts";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { executionLabel } from "./execution-identity.ts";
import { OperationReceiptError } from "./operation-receipt-error.ts";
import { mapLimit } from "./concurrency.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const itemSchema = z.strictObject({
  index: z.number().int().nonnegative(), device: z.string().min(1).max(100), context: z.enum(["user", "system", "desktop"]),
  identity: z.enum(["owner", "root", "interactive"]), fingerprint: hash, agentFingerprint: hash, cwdHash: hash, routeHash: hash,
  idempotencyKey: z.string().max(200), state: z.enum(["not_started", "start_uncertain", "running", "terminal", "failed"]),
  updatedAt: z.string().datetime(), jobId: z.string().min(1).max(200).optional(),
  executionState: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]).optional(),
  exitCode: z.number().int().nullable().optional(), finishedAt: z.string().optional(),
  lastCheckedAt: z.string().datetime().optional(), observation: z.enum(["available", "unavailable", "missing", "conflict"]).optional(),
  verification: z.literal("unknown"), output: z.object({ tool: z.literal("job_output"), stdout: z.literal(0), stderr: z.literal(0) }).optional(),
});
export const durableBatchSchema = z.strictObject({
  version: z.literal(1), operationId: hash, fingerprint: hash, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  cancelled: z.boolean(), items: z.array(itemSchema).min(1).max(64), recoveryOnly: z.boolean(),
  clientAcceptance: z.literal("unknown"),
});
type Manifest = z.infer<typeof durableBatchSchema>;
export type BatchPlan = { device: string; target: AgentEndpointContext; request: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number } };
const maxManifestBytes = 128 * 1024;
const maxOperations = 512; // Pinned no-replay tombstones: fail admission; never evict by age.
function fail(code: string): never { throw new OperationReceiptError(code, { code, recovery: "Use batch_recover; never replay an uncertain operation." }); }
function readBounded(file: string, maxBytes = maxManifestBytes) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maxBytes) fail("batch_manifest_invalid"); return readFileSync(fd); }
  finally { closeSync(fd); }
}
function syncDir(root: string) { if (process.platform !== "win32") { const fd = openSync(root, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } }
export class DurableBatchStore {
  readonly root: string;
  private readonly client: AgentClient;
  constructor(client: AgentClient, directory: string) {
    this.client = client;
    if (!path.isAbsolute(directory)) fail("batch_state_directory_required");
    this.root = path.join(directory, "batch-operations");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  private routeHash(device: string, context: AgentEndpointContext) {
    const configured = this.client.devices.find(d => d.name.toLowerCase() === device.toLowerCase());
    if (!configured) fail("batch_route_unavailable");
    return digest([configured.name, configured.transport ?? "http", context,
      context === "desktop" ? configured.desktopUrl : context === "user" ? configured.userUrl ?? configured.desktopUrl : configured.url]);
  }
  private file(id: string) { if (!hash.safeParse(id).success) fail("batch_operation_invalid"); return path.join(this.root, id + ".json"); }
  private read(id: string) {
    try { const value = durableBatchSchema.parse(JSON.parse(readBounded(this.file(id)).toString("utf8"))); if (value.operationId !== id) fail("batch_manifest_invalid"); return value; }
    catch { return fail("batch_recovery_unavailable"); }
  }
  private save(value: Manifest) {
    durableBatchSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(value)) > maxManifestBytes) fail("batch_manifest_limit");
    // Include staging/orphan files; no cleanup can erase uncertain evidence.
    let bytes = 0;
    for (const name of readdirSync(this.root)) { const stat = lstatSync(path.join(this.root, name)); if (!stat.isFile() || stat.isSymbolicLink()) fail("batch_state_invalid"); bytes += stat.size; }
    if (bytes + Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024) fail("batch_retention_full");
    measureSync("persistence", () => atomicWriteJson(this.file(value.operationId), value));
  }
  private reserve(value: Manifest): boolean {
    const lock = path.join(this.root, ".admission.lock");
    let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { return fail("batch_admission_locked"); }
    try {
      const reservation = path.join(this.root, value.operationId + ".reserve");
      if (existsSync(reservation)) return false;
      if (existsSync(this.file(value.operationId))) fail("batch_reservation_missing");
      const files = readdirSync(this.root);
      // Aggregate bytes are bounded by fixed per-record ceilings and fixed slots,
      // plus a tighter actual-size quota. Never rotate reservation evidence.
      if (files.filter(f => f.endsWith(".reserve")).length >= maxOperations) fail("batch_retention_full");
      let bytes = 0;
      for (const name of files) if (name.endsWith(".json")) bytes += readBounded(path.join(this.root, name)).length;
      if (bytes + Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 * 1024) fail("batch_retention_full");
      const reservationFd = openSync(reservation, "wx", 0o600);
      try { writeFileSync(reservationFd, JSON.stringify({ fingerprint: value.fingerprint })); fsyncSync(reservationFd); }
      finally { closeSync(reservationFd); }
      syncDir(this.root);
      this.save(value); // Entire bounded manifest precedes the first dispatch.
      return true;
    } finally { closeSync(fd); unlinkSync(lock); syncDir(this.root); }
  }
  async start(operationKey: string, plans: BatchPlan[], concurrency = 4, signal?: AbortSignal) {
    if (!operationKey || operationKey.length > 200) fail("batch_operation_key_required");
    if (!plans.length || plans.length > 64) fail("batch_items_invalid");
    // Durable jobs deliberately require explicit cancellation. Do not silently
    // discard synchronous exec deadlines or output caps during migration.
    if (plans.some(p => p.request.timeoutMs !== undefined || p.request.maxOutputBytes !== undefined)) fail("batch_durable_options_unsupported");
    const operationId = digest(operationKey), now = new Date().toISOString();
    const items = plans.map((p, index) => ({ index, device: p.device, context: p.target, identity: executionLabel(p.target),
      fingerprint: digest([p.device, p.target, this.routeHash(p.device, p.target), p.request.command, p.request.cwd ?? null, Object.entries(p.request.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]),
      agentFingerprint: jobStartFingerprint(p.request), cwdHash: digest(p.request.cwd ?? null), routeHash: this.routeHash(p.device, p.target), idempotencyKey: `batch:${operationId}:${index}`, state: "not_started" as const,
      updatedAt: now, verification: "unknown" as const }));
    const fingerprint = digest(items.map(i => i.fingerprint));
    const manifest: Manifest = { version: 1, operationId, fingerprint, items, createdAt: now, updatedAt: now, cancelled: false, recoveryOnly: false, clientAcceptance: "unknown" };
    durableBatchSchema.parse(manifest);
    if (!this.reserve(manifest)) {
      const prior = this.read(operationId);
      if (prior.fingerprint !== fingerprint) fail("batch_operation_conflict");
      return measureAsync("reconciliation", () => this.recover({ operationId }, signal));
    }
    // New controllers must not silently send keyed work to an old agent that
    // ignores the key. Probe every resolved identity before any dispatch.
    for (const item of manifest.items) {
      if (signal?.aborted) break;
      let info: { runtime?: { capabilities?: string[] } };
      try { info = await this.client.info(item.device, item.context, { signal }) as typeof info; }
      catch (error) { if (signal?.aborted) break; throw error; }
      if (!info?.runtime?.capabilities?.includes("job-key-recovery-v1")) fail("batch_agent_upgrade_required");
    }
    let next = 0; let persistenceFailure: unknown;
    await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, concurrency), 32, plans.length) }, async () => {
      while (!signal?.aborted && !persistenceFailure) {
        const index = next++; if (index >= plans.length) break;
        const item = manifest.items[index]!, plan = plans[index]!;
        item.state = "start_uncertain"; item.updatedAt = manifest.updatedAt = new Date().toISOString();
        try { this.save(manifest); } catch (error) { persistenceFailure = error; return; } // No request before durable reservation.
        try {
          const result = await this.client.jobStart(plan.device, { ...plan.request, idempotencyKey: item.idempotencyKey }, plan.target, { signal });
          this.applyStatus(item, result);
        } catch { /* Missing receipt remains uncertain; no retry. */ }
        item.updatedAt = manifest.updatedAt = new Date().toISOString();
        try { this.save(manifest); } catch (error) { persistenceFailure = error; return; }
      }
    }));
    if (persistenceFailure) fail("batch_persistence_uncertain");
    manifest.cancelled = Boolean(signal?.aborted); manifest.updatedAt = new Date().toISOString(); this.save(manifest);
    return manifest;
  }
  private applyStatus(item: Manifest["items"][number], result: unknown) {
    const parsed = z.object({ id: z.string().min(1).max(200), state: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]),
      exitCode: z.number().int().nullable().optional(), finishedAt: z.string().optional() }).safeParse(result);
    if (!parsed.success || item.jobId && item.jobId !== parsed.data.id) return;
    const job = parsed.data;
    item.observation = "available";
    item.jobId = job.id; item.executionState = job.state;
    item.state = ["running", "cancelling"].includes(job.state) ? "running" : job.state === "lost" || job.state === "completed" && typeof job.exitCode === "number" && job.exitCode !== 0 ? "failed" : "terminal";
    item.exitCode = job.exitCode; item.finishedAt = job.finishedAt;
    item.output = { tool: "job_output", stdout: 0, stderr: 0 };
  }
  async recover(input: { operationKey?: string; operationId?: string }, signal?: AbortSignal): Promise<Manifest> {
    signal?.throwIfAborted();
    const id = input.operationId ?? (input.operationKey ? digest(input.operationKey) : fail("batch_operation_key_required"));
    const manifest = this.read(id); manifest.recoveryOnly = true;
    // Disk manifest is immutable to readers. Never race the sole dispatch writer.
    // Bound read latency and drain active requests before propagating abort.
    await mapLimit(manifest.items, 4, async item => {
      if (item.state === "not_started") return;
      if (item.routeHash !== this.routeHash(item.device, item.context)) fail("batch_route_changed");
      item.lastCheckedAt = new Date().toISOString();
      item.observation = "unavailable";
      try {
        if (item.jobId) this.applyStatus(item, await this.client.jobStatus(item.device, item.jobId, item.context, { signal }));
        else {
          const result = await this.client.jobStatusByKey(item.device, item.idempotencyKey, item.context, { signal }) as { state?: string; job?: unknown; jobId?: string; fingerprint?: string };
          if (result?.state === "resolved" && result.fingerprint === item.agentFingerprint && result.jobId === (result.job as { id?: unknown })?.id) this.applyStatus(item, result.job);
          else if (result?.fingerprint !== undefined && result.fingerprint !== item.agentFingerprint) item.observation = "conflict";
          else if (result?.state === "not_found") item.observation = "missing";
        }
      } catch { /* Retain prior evidence; unavailable is not permission to execute. */ }
    }, signal);
    return manifest;
  }
}
export function configuredBatchStore(client: AgentClient) {
  const directory = process.env.RCMCP_STATE_DIR;
  if (!directory) fail("batch_state_directory_required");
  return new DurableBatchStore(client, directory);
}
