import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContextKeepBridge } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { historicallyResolveEntry, readEntry, saveEntry } from "../apps/mcp-server/src/contextkeep-journal.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { OperationObserver } from "../apps/mcp-server/src/operation-observer.ts";
import { withJobDiagnostics } from "../apps/mcp-server/src/job-diagnostics.ts";
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); vi.useRealTimers(); });
function directory() { const root = mkdtempSync(path.join(tmpdir(), "review-regression-")); closers.push(() => rmSync(root, { recursive: true, force: true })); return root; }

it("reconciles a parked observation ACK conflict with exact terminal evidence, retaining the real attach ACK", async () => {
  const root = directory(), recovery = directory();
  const scope = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const run = { id: scope.runId, projectId: scope.projectId, taskId: scope.taskId, externalJobId: "synthetic-job", device: "fixture", identity: "owner", revision: 2, status: "running", verification: "pending" };
  const client = { jobStart: vi.fn(async () => ({ id: "synthetic-job" })), jobStatus: vi.fn(async () => ({ id: "synthetic-job", state: "completed", exitCode: 1, finishedAt: "2026-01-01T00:00:00Z" })) };
  const call = vi.fn(async (name: string) => name === "attach_run_job" ? { run } : name === "observe_run" ? { run: { ...run, revision: 3, status: "failed", verification: "failed" } } : { task: { id: scope.taskId }, runs: [run], pagination: { offset: 0, limit: 50, totalRuns: 1 } });
  const bridge = new ContextKeepBridge(client as unknown as AgentClient, { directory: root, url: "http://127.0.0.1/mcp", token: "fixture" }, call);
  closers.push(() => bridge.close());
  const input = { command: "synthetic", idempotencyKey: "one-intent" };
  await bridge.start("fixture", "user", input, scope); await bridge.pump();
  const file = readdirSync(root).find(name => name.endsWith(".json"))!;
  const key = file.slice(0, -5), entry = readEntry(root, key);
  expect(entry).toMatchObject({ state: "reconciliation_required", attachAcknowledged: true, lastError: "ack_mismatch" });
  entry.remoteEvidence = { projectId: scope.projectId, taskId: scope.taskId, runId: scope.runId, jobId: "synthetic-job", revision: 3, status: "failed", verification: "failed" };
  saveEntry(root, entry);
  const before = readFileSync(path.join(root, file));
  const evidenceRecordId = randomUUID();
  const evidence = { ...entry.remoteEvidence, evidenceRecordId, journalSha256: createHash("sha256").update(before).digest("hex") };
  const args = { key, expectedHash: entry.hash, expectedJobId: entry.jobId!, expectedRunId: scope.runId, evidenceRecordId, evidence };
  expect(() => historicallyResolveEntry(root, recovery, { ...args, evidence: { ...evidence, verification: "passed" } })).toThrow();
  expect(() => historicallyResolveEntry(root, recovery, { ...args, evidence: { ...evidence, journalSha256: "0".repeat(64) } })).toThrow();
  expect(() => historicallyResolveEntry(root, recovery, { ...args, evidence: { ...evidence, jobId: "wrong-job" } })).toThrow();
  expect(readFileSync(path.join(root, file))).toEqual(before);
  historicallyResolveEntry(root, recovery, args);
  expect(readEntry(root, key)).toMatchObject({ state: "historical_resolved", attachAcknowledged: true, observed: { exitCode: 1 }, remoteEvidence: { verification: "failed" } });
  expect(readFileSync(path.join(recovery, readdirSync(recovery).find(name => name.endsWith(".before.json"))!))).toEqual(before);
  await bridge.pump(); await bridge.start("fixture", "user", input, scope);
  expect(client.jobStart).toHaveBeenCalledTimes(1);
});

it("diagnoses a long-lived job recovered by its idempotency key without changing the envelope", () => {
  const value = { state: "resolved", idempotencyKey: "fixture", job: { id: "job", state: "running", startedAt: "2026-01-01T00:00:00Z" } };
  expect(withJobDiagnostics(value, Date.parse("2026-01-02T00:00:00Z"))).toMatchObject({ state: "resolved", idempotencyKey: "fixture", job: { state: "running", lifecycleDiagnostics: { reviewRecommended: true } } });
  expect(value.job).not.toHaveProperty("lifecycleDiagnostics");
});

it("persists capacity loss during temporary reconciliation across a second idle restart", async () => {
  const root = directory(), initial = new OperationObserver(root);
  const retired = (await initial.begin("device_info", undefined))!; await initial.finish(retired, {}, true, false);
  const retained = (await initial.begin("job_start", undefined))!;
  const saved = JSON.parse(readFileSync(path.join(root, retained + ".json"), "utf8"));
  saved.jobs = [{ device: "fixture", identity: "owner", jobId: "x".repeat(256) }];
  const budget = (await initial.health()).retainedBytes + 16;
  writeFileSync(path.join(root, retained + ".json." + randomUUID() + ".tmp"), JSON.stringify(saved));
  const first = await new OperationObserver(root, 20, budget).health();
  expect(first).toMatchObject({ historyHasGaps: true, counters: { evicted: 1, recoveredTemporaries: 1 } });
  const second = await new OperationObserver(root, 20, budget).health();
  expect(second).toMatchObject({ historyHasGaps: true, counters: { evicted: 1, recoveredTemporaries: 1 }, lastCapacityEvictionAt: first.lastCapacityEvictionAt });
});

it("expires idle daily buckets both in memory and after restart without requiring an observed operation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  const root = directory(), observer = new OperationObserver(root);
  const id = (await observer.begin("device_info", undefined))!; await observer.finish(id, {}, true, false);
  expect((await observer.health()).dailySummary).toHaveLength(1);
  vi.setSystemTime(new Date("2026-02-01T12:00:00Z"));
  expect((await observer.health()).dailySummary).toEqual([]);
  expect((await new OperationObserver(root).health()).dailySummary).toEqual([]);
});


it("returns today and six preceding UTC dates, excluding the eighth full-day bucket", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const observer = new OperationObserver();
  for (let day = 1; day <= 8; day++) {
    vi.setSystemTime(new Date("2026-01-" + String(day).padStart(2, "0") + "T12:00:00Z"));
    const id = (await observer.begin("device_info", undefined))!;
    await observer.finish(id, {}, true, false);
  }
  expect((await observer.health()).dailySummary.map(day => day.date)).toEqual([
    "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
  ]);
});
