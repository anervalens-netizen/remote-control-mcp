import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import * as journal from "../apps/mcp-server/src/contextkeep-journal.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())); vi.restoreAllMocks(); vi.useRealTimers(); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01"));
  const root = mkdtempSync(path.join(os.tmpdir(), "ck-wave-")); dirs.push(root);
  const correlation = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const run = { id: correlation.runId, projectId: correlation.projectId, taskId: correlation.taskId, externalJobId: "job", device: "fixture", identity: "owner", revision: 3, status: "running", verification: "pending" };
  const client = { jobStart: vi.fn(async () => ({ id: "job" })), jobStatus: vi.fn(async () => ({ id: "job", state: "running" })) };
  const call = vi.fn(async (name: string): Promise<any> => name === "get_task" ? { task: {}, runs: [{ ...run }], pagination: { offset: 0, limit: 50, totalRuns: 1 } } : { run: { ...run } });
  const make = () => { const b = new ContextKeepBridge(client as unknown as AgentClient, { directory: root, url: "http://127.0.0.1", token: "synthetic" }, call); bridges.push(b); return b; };
  const entry = () => journal.readEntry(root, readdirSync(root).find(n => n.endsWith(".json"))!.slice(0, -5));
  return { root, correlation, run, client, call, make, entry };
}
it("twenty unchanged running polls avoid twenty full durable receipt writes; counters and schedule stay visible", async () => {
  const f = fixture(), b = f.make(); await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, f.correlation);
  await b.pump(); const before = b.diagnostics().durableWrites;
  for (let i = 0; i < 20; i++) { await vi.advanceTimersByTimeAsync(2000); await b.pump(); }
  expect(b.diagnostics()).toMatchObject({ durableWrites: before, schedulingWritesAvoided: 21, entries: [{ actualAttempts: 21, backoffExponent: 0 }] });
  expect(f.client.jobStart).toHaveBeenCalledTimes(1);
  await b.close(); const restarted = f.make(); await restarted.pump(); expect(f.client.jobStart).toHaveBeenCalledTimes(1);
  console.log(JSON.stringify({ scenario: "20 running polls", beforeSchedulingWrites: 20, afterSchedulingWrites: b.diagnostics().durableWrites - before }));
});
it.each([false, true])("fail, fail, success, fail resets backoff and retains actual retry counts (restart=%s)", async restart => {
  const f = fixture(); let b = f.make();
  await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "reset" }, f.correlation);
  // Establish the durable attach proof; subsequent success is an unchanged poll.
  await b.pump();
  for (const exponent of [1, 2]) {
    f.client.jobStatus.mockRejectedValueOnce(new Error("synthetic offline"));
    await vi.advanceTimersByTimeAsync(2000); await b.pump();
    expect(b.diagnostics().entries[0]).toMatchObject({ actualRetries: exponent, backoffExponent: exponent });
  }
  await vi.advanceTimersByTimeAsync(4000);
  const writes = b.diagnostics().durableWrites;
  await b.pump();
  expect(b.diagnostics()).toMatchObject({ durableWrites: writes + 1, entries: [{ actualAttempts: 4, actualRetries: 2, backoffExponent: 0 }] });
  expect(f.entry()).toMatchObject({ attempts: 0, totalRetries: 2 });
  expect(f.entry().lastError).toBeUndefined();
  // Reconciliation and fresh process reads must both retain the reset.
  await vi.advanceTimersByTimeAsync(60_000);
  if (restart) { await b.close(); b = f.make(); }
  expect(b.diagnostics().entries[0]).toMatchObject({ actualRetries: 2, backoffExponent: 0 });
  const resetWrites = b.diagnostics().durableWrites;
  await b.pump();
  expect(b.diagnostics().durableWrites).toBe(resetWrites);
  await vi.advanceTimersByTimeAsync(2000);
  f.client.jobStatus.mockRejectedValueOnce(new Error("synthetic offline again"));
  await b.pump();
  expect(b.diagnostics().entries[0]).toMatchObject({ actualAttempts: 6, actualRetries: 3, backoffExponent: 1, nextAttemptAt: Date.now() + 2000 });
  expect(f.entry()).toMatchObject({ attempts: 1, totalAttempts: 6, totalRetries: 3 });
  expect(f.client.jobStart).toHaveBeenCalledTimes(1);
});
it("offline/reconnect and lost observation ACK converge without start replay, preserving terminal-negative evidence", async () => {
  const f = fixture(), b = f.make(); await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, f.correlation);
  f.call.mockRejectedValue(new Error("synthetic offline")); await b.pump(); expect(f.entry()).toMatchObject({ attempts: 1, totalAttempts: 1, attachAcknowledged: false });
  let lost = false;
  f.call.mockImplementation(async name => {
    if (name === "get_task") return { task: {}, runs: [{ ...f.run }], pagination: { offset: 0, limit: 50, totalRuns: 1 } };
    if (name === "observe_run") { lost = true; f.run.status = "failed"; f.run.verification = "failed"; throw new Error("ACK lost"); }
    return { run: { ...f.run } };
  });
  f.client.jobStatus.mockResolvedValue({ id: "job", state: "completed", exitCode: 7, finishedAt: "2026-01-01T00:00:00.000Z" } as any);
  await vi.advanceTimersByTimeAsync(2001); await b.pump(); expect(lost).toBe(true); expect(f.entry().state).toBe("tracking");
  await vi.advanceTimersByTimeAsync(4001); await b.pump();
  expect(f.entry()).toMatchObject({ state: "delivered", observed: { exitCode: 7 }, remoteEvidence: { status: "failed", verification: "failed" } });
  expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(f.call.mock.calls.filter(([name]) => name === "observe_run")).toHaveLength(1);
});
it("actual attempts continue above capped backoff and terminal-negative proof debt remains explicit", async () => {
  const f = fixture(), b = f.make(); await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, f.correlation);
  f.run.status = "lost"; f.run.verification = "failed";
  f.call.mockImplementation(async name => { if (name !== "get_task") throw new Error("stale lease"); return { task: {}, runs: [{ ...f.run }], pagination: { offset: 0, limit: 50, totalRuns: 1 } }; });
  for (let i = 0; i < 35; i++) { await b.pump(); await vi.advanceTimersByTimeAsync(300001); }
  expect(f.entry()).toMatchObject({ state: "tracking", attempts: 30, totalAttempts: 35, lastError: "proof_missing", attachAcknowledged: false, remoteEvidence: { status: "lost", verification: "failed" } });
  expect(b.diagnostics().entries[0]).toMatchObject({ classification: "terminal_negative", actualAttempts: 35, backoffExponent: 9, negativeFact: { status: "lost", verification: "failed" } });
});
it("orphan lock is visible and fail-closed; only exact fenced evidence archives it and creates a negative no-replay tombstone", async () => {
  const f = fixture(), b = f.make(), recovery = mkdtempSync(path.join(os.tmpdir(), "ck-evidence-")); dirs.push(recovery);
  const key = createHash("sha256").update(JSON.stringify(["fixture", "user", "one"])).digest("hex");
  const raw = JSON.stringify({ version: 2, key, hash: jobInputHash({ command: "synthetic" }), device: "fixture", target: "user", correlation: f.correlation,
    state: "tracking", jobId: "job", attachKey: randomUUID(), observeKey: randomUUID(), attachAcknowledged: false, createdAt: Date.now(), attempts: 0, nextAttemptAt: 0 });
  const lock = "synthetic preserved lock"; writeFileSync(path.join(f.root, key + ".lock"), lock);
  expect(b.diagnostics()).toMatchObject({ orphanLockCount: 1, lockedCount: 1, snapshotAgeMs: 0 });
  await expect(b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, f.correlation)).rejects.toThrow("uncertain");
  const evidence = { projectId: f.correlation.projectId, taskId: f.correlation.taskId, runId: f.correlation.runId, jobId: "job", revision: 4,
    status: "lost" as const, verification: "failed" as const, evidenceRecordId: randomUUID(), journalSha256: createHash("sha256").update(raw).digest("hex") };
  const input = { key, expectedLockSha256: createHash("sha256").update(lock).digest("hex"), originalReceipt: raw, writersFenced: true as const, evidence };
  expect(() => journal.reconcileOrphanLock(f.root, recovery, { ...input, evidence: { ...evidence, jobId: "wrong" } })).toThrow();
  expect(readFileSync(path.join(f.root, key + ".lock"), "utf8")).toBe(lock);
  const result = journal.reconcileOrphanLock(f.root, recovery, input);
  expect(result).toMatchObject({ state: "historical_resolved", attachAcknowledged: false, historicalResolution: { evidence: { status: "lost", verification: "failed" } } });
  expect(readdirSync(recovery)).toHaveLength(2); expect(readdirSync(f.root).some(n => n.includes(".resolved-lock."))).toBe(true);
  await f.make().start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, f.correlation); expect(f.client.jobStart).not.toHaveBeenCalled();
});

it("failure failure success failure resets durable backoff once and healthy polls keep zero scheduling writes", async () => {
  const f = fixture(), b = f.make();
  await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "reset" }, f.correlation);
  await b.pump(); // Persist attachment before isolating scheduling writes.
  const fail = () => f.client.jobStatus.mockRejectedValueOnce(new Error("synthetic offline"));
  fail(); await vi.advanceTimersByTimeAsync(2000); await b.pump();
  fail(); await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(f.entry()).toMatchObject({ attempts: 2, totalRetries: 2 });
  const beforeReset = b.diagnostics().durableWrites;
  await vi.advanceTimersByTimeAsync(4000); await b.pump();
  expect(f.entry()).toMatchObject({ attempts: 0, totalRetries: 2 });
  expect(f.entry().lastError).toBeUndefined();
  const resetWrites = b.diagnostics().durableWrites - beforeReset;
  expect(resetWrites).toBe(1);
  fail(); await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(f.entry()).toMatchObject({ attempts: 1, totalRetries: 3 });
  expect(b.diagnostics().entries[0]).toMatchObject({ backoffExponent: 1, nextAttemptAt: Date.now() + 2000 });
  await vi.advanceTimersByTimeAsync(2000); await b.pump();
  const beforeHealthy = b.diagnostics().durableWrites;
  for (let i = 0; i < 40; i++) { await vi.advanceTimersByTimeAsync(2000); await b.pump(); }
  expect(b.diagnostics().durableWrites - beforeHealthy).toBe(0);
  expect(b.diagnostics().entries[0]).toMatchObject({ backoffExponent: 0 });
  await b.close();
  const restarted = f.make(); fail(); await restarted.pump();
  expect(f.entry()).toMatchObject({ attempts: 1, totalRetries: 4 });
  expect(f.client.jobStart).toHaveBeenCalledTimes(1);
  console.log(JSON.stringify({ scenario: "backoff reset then 40 healthy polls", resetWrites, healthySchedulingWrites: b.diagnostics().durableWrites - beforeHealthy }));
});

it("a failed backoff-reset save retains durable failure evidence and retries the reset without replay", async () => {
  const f = fixture(), b = f.make();
  await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "reset-io" }, f.correlation);
  await b.pump();
  f.client.jobStatus.mockRejectedValueOnce(new Error("synthetic offline"));
  await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(f.entry().attempts).toBe(1);
  vi.spyOn(journal, "saveEntry").mockImplementationOnce(() => { throw new Error("synthetic disk failure"); });
  await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(f.entry().attempts).toBe(1);
  expect(b.diagnostics()).toMatchObject({ writeFailures: 1, entries: [{ lastError: "journal", backoffExponent: 1 }] });
  const reads = f.client.jobStatus.mock.calls.length;
  await b.pump(); expect(f.client.jobStatus).toHaveBeenCalledTimes(reads);
  await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(f.entry()).toMatchObject({ attempts: 0, totalRetries: 1 });
  const writes = b.diagnostics().durableWrites;
  await vi.advanceTimersByTimeAsync(2000); await b.pump();
  expect(b.diagnostics().durableWrites).toBe(writes);
  expect(f.client.jobStart).toHaveBeenCalledTimes(1);
});
