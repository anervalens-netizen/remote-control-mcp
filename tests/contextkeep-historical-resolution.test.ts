import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { historicallyResolveEntry, readEntry, type Entry } from "../apps/mcp-server/src/contextkeep-journal.ts";

const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "rcmcp-history-")); dirs.push(directory);
  const key = createHash("sha256").update(JSON.stringify(["fixture", "user", "legacy"])).digest("hex");
  const correlation = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const entry: Entry = {
    version: 2, key, hash: jobInputHash({ command: "fixture" }),
    device: "fixture", target: "user", correlation, state: "tracking", jobId: "legacy-job",
    attachKey: randomUUID(), observeKey: randomUUID(), attachAcknowledged: false,
    createdAt: Date.now() - 10_000, attempts: 30, nextAttemptAt: Date.now(), lastError: "proof_missing",
  };
  const file = path.join(directory, key + ".json"); writeFileSync(file, JSON.stringify(entry));
  return { directory, entry, file };
}
it("turns an unresolved historical receipt into a non-retrying no-replay tombstone without inventing an ACK", async () => {
  const f = fixture(), before = readFileSync(f.file);
  const evidenceRecordId = randomUUID();
  const resolved = historicallyResolveEntry(f.directory, {
    key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId, resolvedAt: "2026-10-01T08:45:00.000Z",
  });
  expect(resolved).toMatchObject({
    version: 3, state: "historical_resolved", attachAcknowledged: false, attempts: 0, nextAttemptAt: 0,
    historicalResolution: {
      reason: "retrospective_verification", resolvedAt: "2026-10-01T08:45:00.000Z",
      evidenceRecordId, originalRecordSha256: createHash("sha256").update(before).digest("hex"),
    },
  });
  expect(readEntry(f.directory, f.entry.key)).toEqual(resolved);
  const client = {
    jobStart: vi.fn(async () => ({ id: "should-not-start" })),
    jobStatus: vi.fn(async () => ({ id: "legacy-job", state: "completed", exitCode: 0, finishedAt: "2026-09-30T11:00:00.000Z" })),
  };
  const bridge = new ContextKeepBridge(client as unknown as AgentClient, { directory: f.directory, url: "http://127.0.0.1/mcp", token: "synthetic" }, vi.fn());
  bridges.push(bridge);
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 0, corruptCount: 0 });
  await expect(bridge.start("fixture", "user", { command: "fixture", idempotencyKey: "legacy" }, f.entry.correlation)).resolves.toMatchObject({ id: "legacy-job" });
  expect(client.jobStart).not.toHaveBeenCalled();
  expect(client.jobStatus).toHaveBeenCalledTimes(1);
});
it("refuses mismatched historical evidence and leaves the durable receipt byte-identical", () => {
  const f = fixture(), before = readFileSync(f.file);
  expect(() => historicallyResolveEntry(f.directory, {
    key: f.entry.key, expectedHash: "0".repeat(64), expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: randomUUID(),
  })).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
