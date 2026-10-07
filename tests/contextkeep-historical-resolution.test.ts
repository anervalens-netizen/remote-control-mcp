import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { historicallyResolveEntry, readEntry, saveEntry, type Entry } from "../apps/mcp-server/src/contextkeep-journal.ts";

const fault = vi.hoisted(() => ({ syncParent: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: (fd: number) => {
    if (fault.syncParent && actual.fstatSync(fd).ino === actual.statSync(fault.syncParent).ino)
      throw Object.assign(new Error('synthetic parent sync failure'), { code: 'EIO' });
    return actual.fsyncSync(fd);
  } };
});
const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => {
  fault.syncParent = "";
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "rcmcp-history-"));
  const recoveryDirectory = mkdtempSync(path.join(tmpdir(), "rcmcp-history-recovery-"));
  dirs.push(directory, recoveryDirectory);
  const key = createHash("sha256").update(JSON.stringify(["fixture", "user", "legacy"])).digest("hex");
  const correlation = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const entry: Entry = {
    version: 2, key, hash: jobInputHash({ command: "fixture" }),
    device: "fixture", target: "user", correlation, state: "tracking", jobId: "legacy-job",
    attachKey: randomUUID(), observeKey: randomUUID(), attachAcknowledged: false,
    createdAt: Date.now() - 10_000, attempts: 30, nextAttemptAt: Date.now(), lastError: "proof_missing",
  };
  const file = path.join(directory, key + ".json");
  writeFileSync(file, JSON.stringify(entry));
  const evidenceRecordId = randomUUID();
  const evidence = { projectId: correlation.projectId, taskId: correlation.taskId, runId: correlation.runId, jobId: entry.jobId!,
    revision: 4, status: "failed" as const, verification: "failed" as const, evidenceRecordId,
    journalSha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  return { directory, recoveryDirectory, entry, file, evidenceRecordId, evidence };
}
it("turns an unresolved historical receipt into a non-retrying no-replay tombstone with a recovery copy", async () => {
  const f = fixture(), before = readFileSync(f.file);
  const evidenceRecordId = f.evidenceRecordId;
  const resolved = historicallyResolveEntry(f.directory, f.recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
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
  const recovery = readdirSync(f.recoveryDirectory);
  expect(recovery).toHaveLength(1);
  expect(readFileSync(path.join(f.recoveryDirectory, recovery[0]!))).toEqual(before);
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
  expect(() => historicallyResolveEntry(f.directory, f.recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: "0".repeat(64), expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
  expect(readdirSync(f.recoveryDirectory)).toHaveLength(0);
});
it("serializes historical disposition with normal journal writes", () => {
  const f = fixture(), before = readFileSync(f.file);
  const lock = path.join(f.directory, f.entry.key + ".lock");
  writeFileSync(lock, "synthetic lock");
  expect(() => historicallyResolveEntry(f.directory, f.recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
  expect(() => saveEntry(f.directory, { ...f.entry, attempts: 29 })).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
  expect(readdirSync(f.recoveryDirectory)).toHaveLength(0);
});
it("applies normal journal bounds before recovery or mutation", () => {
  const f = fixture(), oversized = Buffer.alloc(64 * 1024 + 1, 65);
  writeFileSync(f.file, oversized);
  expect(() => historicallyResolveEntry(f.directory, f.recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
  expect(readFileSync(f.file)).toEqual(oversized);
  expect(readdirSync(f.recoveryDirectory)).toHaveLength(0);
});
it("requires absolute journal and recovery directories", () => {
  const f = fixture();
  expect(() => historicallyResolveEntry("relative-journal", f.recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
  expect(() => historicallyResolveEntry(f.directory, "relative-recovery", {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
});
it.each(["projectId", "taskId", "runId", "jobId", "journalSha256"] as const)("rejects an unrelated %s in the evidence tuple before backup or mutation", field => {
  const f = fixture(), before = readFileSync(f.file);
  const evidence = { ...f.evidence, [field]: field === "journalSha256" ? "0".repeat(64) : randomUUID() };
  expect(() => historicallyResolveEntry(f.directory, f.recoveryDirectory, {
    evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!, expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  })).toThrow();
  expect(readFileSync(f.file)).toEqual(before); expect(readdirSync(f.recoveryDirectory)).toHaveLength(0);
});
it("never upgrades a retained negative fact through historical disposition", () => {
  const f = fixture();
  writeFileSync(f.file, JSON.stringify({ ...f.entry, remoteEvidence: { projectId: f.evidence.projectId, taskId: f.evidence.taskId,
    runId: f.evidence.runId, jobId: f.evidence.jobId, revision: 4, status: "lost", verification: "failed" } }));
  const before = readFileSync(f.file), journalSha256 = createHash("sha256").update(before).digest("hex");
  for (const change of [{ status: "completed" as const }, { status: "lost" as const, verification: "passed" as const }, { status: "lost" as const, revision: 3 }]) {
    expect(() => historicallyResolveEntry(f.directory, f.recoveryDirectory, {
      evidence: { ...f.evidence, journalSha256, ...change }, key: f.entry.key, expectedHash: f.entry.hash,
      expectedJobId: f.entry.jobId!, expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
    })).toThrow();
  }
  expect(readFileSync(f.file)).toEqual(before); expect(readdirSync(f.recoveryDirectory)).toHaveLength(0);
});

function resolveFixture(f: ReturnType<typeof fixture>, recoveryDirectory = f.recoveryDirectory) {
  return historicallyResolveEntry(f.directory, recoveryDirectory, {
    evidence: f.evidence, key: f.entry.key, expectedHash: f.entry.hash, expectedJobId: f.entry.jobId!,
    expectedRunId: f.entry.correlation.runId, evidenceRecordId: f.evidenceRecordId,
  });
}
it('rejects a stale worker save after historical resolution', () => {
  const f = fixture();
  const resolved = resolveFixture(f);
  expect(() => saveEntry(f.directory, { ...f.entry, attempts: 31 })).toThrow();
  expect(readEntry(f.directory, f.entry.key)).toEqual(resolved);
});
it.skipIf(process.platform === 'win32')('rejects a recovery symlink to the live receipt', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, f.entry.key + '.' + f.evidence.journalSha256 + '.before.json');
  symlinkSync(f.file, recovery);
  expect(() => resolveFixture(f)).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('does not resolve when a new recovery ancestor cannot be synced', () => {
  const f = fixture(), before = readFileSync(f.file);
  fault.syncParent = f.recoveryDirectory;
  expect(() => resolveFixture(f, path.join(f.recoveryDirectory, 'nested', 'recovery'))).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
