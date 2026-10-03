import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { DurableBatchStore, type BatchPlan } from "../apps/mcp-server/src/durable-batch.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { JobStartDeduplicator } from "../apps/agent/src/job-start-dedup.ts";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "batch-recovery-")); dirs.push(root);
  const jobs = new Map<string, unknown>(); let n = 0;
  const client = { devices: [{ name: "fixture", url: "http://127.0.0.1:1" }],
    info: vi.fn(async () => ({ runtime: { capabilities: ["job-key-recovery-v1"] } })),
    jobStart: vi.fn(async (_device: string, input: any) => { const job = { id: `job-${n++}`, state: "running" }; jobs.set(input.idempotencyKey, job); return job; }),
    jobStatus: vi.fn(async (_device: string, id: string) => ({ id, state: "completed", exitCode: 0 })),
    jobStatusByKey: vi.fn(async (_device: string, key: string) => jobs.has(key) ? { state: "resolved", job: jobs.get(key) } : { state: "not_found" }),
  };
  const make = () => new DurableBatchStore(client as unknown as AgentClient, root);
  const plans: BatchPlan[] = Array.from({ length: 4 }, (_, i) => ({ device: "fixture", target: "system", request: { command: `synthetic-${i}`, env: { SECRET: "synthetic-private" } } }));
  return { root, client, make, plans, jobs };
}
it("requires caller identity and durable manifest, recovers without replay, conflicts on every effect-relevant change", async () => {
  const f = fixture();
  await expect(f.make().start("", f.plans)).rejects.toThrow("batch_operation_key_required");
  f.client.jobStart.mockImplementation(async (_d, input) => {
    const manifest = JSON.parse(readFileSync(path.join(f.root, "batch-operations", readdirSync(path.join(f.root, "batch-operations")).find(n => n.endsWith(".json"))!), "utf8"));
    expect(manifest.items.some((i: any) => i.idempotencyKey === input.idempotencyKey && i.state === "start_uncertain")).toBe(true);
    return { id: input.idempotencyKey, state: "running" };
  });
  const first = await f.make().start("known-key", f.plans, 2);
  const recovered = await f.make().start("known-key", f.plans, 2);
  expect(recovered.recoveryOnly).toBe(true); expect(recovered.items.every(i => i.state === "terminal")).toBe(true);
  expect(f.client.jobStart).toHaveBeenCalledTimes(4);
  for (const request of [{ command: "different" }, { cwd: "/synthetic" }, { env: { SECRET: "changed" } }]) {
    await expect(f.make().start("known-key", [{ ...f.plans[0]!, request: { ...f.plans[0]!.request, ...request } }, ...f.plans.slice(1)])).rejects.toThrow("batch_operation_conflict");
  }
  const raw = readFileSync(path.join(f.root, "batch-operations", first.operationId + ".json"), "utf8");
  expect(raw).not.toMatch(/synthetic-private|synthetic-0|SECRET/);
  f.client.devices[0]!.url = "http://127.0.0.1:2";
  await expect(f.make().recover({ operationKey: "known-key" })).rejects.toThrow("batch_route_changed");
});
it("rejects old agents/options before effects; unknown or orphaned manifests never start", async () => {
  const f = fixture(); f.client.info.mockResolvedValue({ runtime: { capabilities: [] } });
  await expect(f.make().start("old", f.plans)).rejects.toThrow("batch_agent_upgrade_required");
  await expect(f.make().start("options", [{ ...f.plans[0]!, request: { command: "synthetic", timeoutMs: 5 } }])).rejects.toThrow("batch_durable_options_unsupported");
  await expect(f.make().recover({ operationKey: "unknown" })).rejects.toThrow("batch_recovery_unavailable");
  const file = readdirSync(path.join(f.root, "batch-operations")).find(n => n.endsWith(".json"))!;
  rmSync(path.join(f.root, "batch-operations", file));
  await expect(f.make().start("old", f.plans)).rejects.toThrow("batch_recovery_unavailable");
  expect(f.client.jobStart).not.toHaveBeenCalled();
});
it.each([0, 1, 2, 4])("cancellation after %i starts records all slots and never cancels durable jobs", async count => {
  const f = fixture(), controller = new AbortController(); let starts = 0;
  if (!count) controller.abort();
  f.client.jobStart.mockImplementation(async () => { if (++starts === count) controller.abort(); return { id: `job-${starts}`, state: "running" }; });
  const result = await f.make().start("cancel", f.plans, 1, controller.signal);
  expect(result.cancelled).toBe(true); expect(starts).toBe(count);
  expect(result.items.filter(i => i.state === "not_started")).toHaveLength(4 - count);
  await f.make().start("cancel", f.plans);
  expect(starts).toBe(count);
});
it.each(["before-start", "after-two", "after-effect", "after-terminal"])("SIGKILL controller at %s then restart/recover leaves every synthetic effect <=1", async window => {
  const f = fixture();
  const child = fork(path.resolve("tests/fixtures/batch-crash-child.ts"), [f.root, window], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, RCMCP_STATE_DIR: f.root } });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Crash fixture timed out: ${stderr}`)), 10000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Crash fixture exited: ${stderr}`)); });
    });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const dedup = new JobStartDeduplicator(path.join(f.root, "keys"));
    f.client.jobStatus.mockImplementation(async (_d, id) => JSON.parse(readFileSync(path.join(f.root, id + ".job"), "utf8")));
    f.client.jobStatusByKey.mockImplementation(async (_d, key) => {
      const reservation = dedup.lookup(key);
      return reservation.state === "reserved" ? { state: "resolved", jobId: reservation.jobId, fingerprint: reservation.fingerprint, job: JSON.parse(readFileSync(path.join(f.root, reservation.jobId + ".job"), "utf8")) } : { state: "not_found" };
    });
    const plans = f.plans.map(p => ({ ...p, request: { command: p.request.command } }));
    const result = await f.make().start("crash-key", plans);
    expect(result.recoveryOnly).toBe(true); expect(f.client.jobStart).not.toHaveBeenCalled();
    const effects = existsSync(path.join(f.root, "effects")) ? readFileSync(path.join(f.root, "effects"), "utf8").trim().split("\n") : [];
    expect(new Set(effects).size).toBe(effects.length);
    expect(effects.length).toBe(window === "before-start" ? 0 : window === "after-two" ? 2 : 1);
    if (window === "after-effect") expect(result.items[0]).toMatchObject({ state: "running", observation: "available" });
    if (window === "after-terminal") expect(result.items[0]).toMatchObject({ state: "terminal", exitCode: 0 });
    if (window === "after-two") expect(result.items[2]).toMatchObject({ state: "start_uncertain", observation: "missing" });
  } finally { child.kill("SIGKILL"); }
}, 15000);
it("bounds permanent retention and refuses admission without evicting evidence", async () => {
  const f = fixture(), store = f.make();
  for (let i = 0; i < 512; i++) writeFileSync(path.join(store.root, `${i}.reserve`), "synthetic");
  await expect(store.start("full", f.plans)).rejects.toThrow("batch_retention_full");
  expect(f.client.jobStart).not.toHaveBeenCalled(); expect(readdirSync(store.root)).toHaveLength(512);
});

it("recovery refuses a colliding agent key with different input proof", async () => {
  const f = fixture(); f.client.jobStart.mockRejectedValue(new Error("job_start_conflict"));
  const initial = await f.make().start("collision", f.plans);
  f.client.jobStatusByKey.mockResolvedValue({ state: "resolved", fingerprint: "0".repeat(64), jobId: "unrelated", job: { id: "unrelated", state: "completed", exitCode: 0 } } as any);
  const result = await f.make().recover({ operationId: initial.operationId });
  expect(result.items.every(i => i.state === "start_uncertain" && i.observation === "conflict" && !i.jobId)).toBe(true);
  expect(f.client.jobStart).toHaveBeenCalledTimes(4);
});

it.each(["recover", "retry"])("already-aborted %s dispatches zero recovery requests", async mode => {
  const f = fixture(); await f.make().start("abort-read", f.plans);
  const controller = new AbortController(); controller.abort();
  await expect(mode === "recover" ? f.make().recover({ operationKey: "abort-read" }, controller.signal) : f.make().start("abort-read", f.plans, 4, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.client.jobStatus).not.toHaveBeenCalled(); expect(f.client.jobStatusByKey).not.toHaveBeenCalled();
  expect(f.client.jobStart).toHaveBeenCalledTimes(f.plans.length);
});

it.each(["recover", "retry"])("mid-flight %s bounds concurrent reads and aborts status/key requests without touching jobs", async mode => {
  const f = fixture();
  const plans = Array.from({ length: 64 }, (_, i) => ({ ...f.plans[0]!, request: { command: `synthetic-${i}` } }));
  let starts = 0;
  f.client.jobStart.mockImplementation(async () => { if (++starts % 2 === 0) throw new Error("synthetic lost receipt"); return { id: `job-${starts}`, state: "running" }; });
  const initial = await f.make().start("mid-abort", plans);
  const file = path.join(f.root, "batch-operations", initial.operationId + ".json"), before = readFileSync(file, "utf8");
  const controller = new AbortController(), signals: Array<AbortSignal | undefined> = [];
  let active = 0, peak = 0;
  const read = async (_device: string, _id: string, _context?: string, options?: { signal?: AbortSignal }): Promise<any> => {
    signals.push(options?.signal);
    if (!options?.signal) return {}; // Old implementation fails promptly rather than hanging the repro.
    const signal = options.signal;
    active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        if (active === 4) queueMicrotask(() => controller.abort());
      });
    } finally { active--; }
  };
  f.client.jobStatus.mockImplementation(read); f.client.jobStatusByKey.mockImplementation(read);
  await expect(mode === "recover" ? f.make().recover({ operationKey: "mid-abort" }, controller.signal) : f.make().start("mid-abort", plans, 4, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(signals).toHaveLength(4); expect(peak).toBe(4); expect(active).toBe(0);
  expect(signals.every(signal => signal === controller.signal && signal.aborted)).toBe(true);
  expect(f.client.jobStatus).toHaveBeenCalledTimes(2); expect(f.client.jobStatusByKey).toHaveBeenCalledTimes(2);
  expect(f.client.jobStart).toHaveBeenCalledTimes(64);
  expect(readFileSync(file, "utf8")).toBe(before);
});
