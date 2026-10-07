import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { historicallyResolveEntry, readEntry, saveEntry, type Entry } from "../apps/mcp-server/src/contextkeep-journal.ts";

const fault = vi.hoisted(() => ({ syncParent: '', writableRecovery: false, replaceRecovery: '', preventCleanup: false, afterMkdir: undefined as (() => void) | undefined, beforeMkdir: undefined as (() => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const handles = new Map<number, { file: string; flags: string | number }>();
  return { ...actual, openSync: (file: import('node:fs').PathLike, flags: string | number, mode?: import('node:fs').Mode) => {
    if (fault.replaceRecovery === String(file) && typeof flags === 'number') {
      fault.replaceRecovery = '';
      actual.renameSync(file, String(file) + '.moved');
      actual.writeFileSync(file, actual.readFileSync(String(file) + '.moved'));
    }
    const fd = actual.openSync(file, flags, mode);
    handles.set(fd, { file: String(file), flags });
    return fd;
  }, mkdirSync: (file: import('node:fs').PathLike, options?: import('node:fs').MakeDirectoryOptions & { recursive: true }) => {
    const before = fault.beforeMkdir; fault.beforeMkdir = undefined; before?.();
    const result = actual.mkdirSync(file, options);
    const callback = fault.afterMkdir; fault.afterMkdir = undefined; callback?.();
    return result;
  }, rmdirSync: (file: import('node:fs').PathLike) => {
    if (fault.preventCleanup) throw new Error('synthetic cleanup interruption');
    return actual.rmdirSync(file);
  }, fsyncSync: (fd: number) => {
    const handle = handles.get(fd);
    if (fault.writableRecovery && handle?.file.endsWith('.before.json') &&
        typeof handle.flags === 'number' && (handle.flags & 3) === actual.constants.O_RDONLY)
      throw Object.assign(new Error('synthetic writable handle required'), { code: 'EACCES' });
    if (fault.syncParent && actual.fstatSync(fd).ino === actual.statSync(fault.syncParent).ino)
      throw Object.assign(new Error('synthetic parent sync failure'), { code: 'EIO' });
    return actual.fsyncSync(fd);
  } };
});
const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => {
  fault.syncParent = "";
  fault.writableRecovery = false;
  fault.replaceRecovery = '';
  fault.preventCleanup = false;
  fault.afterMkdir = undefined;
  fault.beforeMkdir = undefined;
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
  expect(() => resolveFixture(f, path.join(f.recoveryDirectory, 'nested', 'recovery'))).toThrow();
  fault.syncParent = '';
  expect(resolveFixture(f, path.join(f.recoveryDirectory, 'nested', 'recovery')).state).toBe('historical_resolved');
});

it('flushes a reused recovery file through a writable non-truncating descriptor', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, f.entry.key + '.' + f.evidence.journalSha256 + '.before.json');
  writeFileSync(recovery, before);
  fault.writableRecovery = true;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveFixture(f).state).toBe('historical_resolved');
  } finally { Object.defineProperty(process, 'platform', platform); }
  expect(readFileSync(recovery)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('does not sync unchanged ancestors above the creation boundary', () => {
  const f = fixture();
  const existing = path.join(f.recoveryDirectory, 'existing');
  mkdirSync(existing);
  fault.syncParent = f.recoveryDirectory;
  expect(resolveFixture(f, path.join(existing, 'new', 'recovery')).state).toBe('historical_resolved');
});

it('rejects a recovery object replaced between path inspection and open', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, f.entry.key + '.' + f.evidence.journalSha256 + '.before.json');
  writeFileSync(recovery, before);
  fault.replaceRecovery = recovery;
  expect(() => resolveFixture(f)).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('retains the preparation boundary when an interrupted attempt leaves new directories', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, 'nested', 'recovery');
  fault.preventCleanup = true;
  fault.syncParent = f.recoveryDirectory;
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
  fault.syncParent = '';
  expect(resolveFixture(f, recovery).state).toBe('historical_resolved');
});
it.skipIf(process.platform === 'win32')('can reuse a preserved read-only recovery file on POSIX', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, f.entry.key + '.' + f.evidence.journalSha256 + '.before.json');
  writeFileSync(recovery, before);
  chmodSync(recovery, 0o400);
  expect(resolveFixture(f).state).toBe('historical_resolved');
  expect(readFileSync(recovery)).toEqual(before);
});

it.skipIf(process.platform === 'win32')('shares the original boundary with another entry while first-time creation is in progress', () => {
  const f = fixture();
  const entry = { ...f.entry, key: 'b'.repeat(64) };
  const second = { ...f, entry, file: path.join(f.directory, entry.key + '.json') };
  writeFileSync(second.file, JSON.stringify(entry));
  second.evidence = { ...f.evidence, journalSha256: createHash('sha256').update(readFileSync(second.file)).digest('hex') };
  const recovery = path.join(f.recoveryDirectory, 'nested', 'recovery');
  fault.syncParent = f.recoveryDirectory;
  let concurrentRejected = false;
  fault.afterMkdir = () => {
    try { resolveFixture(second, recovery); } catch { concurrentRejected = true; }
  };
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(concurrentRejected).toBe(true);
  expect(readEntry(second.directory, entry.key).state).toBe('tracking');
});

it.skipIf(process.platform === 'win32')('refuses a restored preparation intent whose established boundary is missing', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, 'nested', 'recovery');
  fault.syncParent = f.recoveryDirectory;
  expect(() => resolveFixture(f, recovery)).toThrow();
  fault.syncParent = '';
  rmSync(f.recoveryDirectory, { recursive: true });
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
it.skipIf(process.platform === 'win32')('accepts an explicitly configured directory symlink', () => {
  const f = fixture();
  const link = path.join(f.directory, 'configured-recovery');
  symlinkSync(f.recoveryDirectory, link, 'dir');
  expect(resolveFixture(f, link).state).toBe('historical_resolved');
  expect(readdirSync(f.recoveryDirectory)).toHaveLength(1);
});

it.skipIf(process.platform === 'win32')('rejects a replaced recovery anchor during creation and on subsequent retry', () => {
  const f = fixture(), before = readFileSync(f.file);
  const recovery = path.join(f.recoveryDirectory, 'nested', 'recovery');
  const moved = f.recoveryDirectory + '.moved'; dirs.push(moved);
  fault.beforeMkdir = () => renameSync(f.recoveryDirectory, moved);
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(() => resolveFixture(f, recovery)).toThrow();
  expect(readFileSync(f.file)).toEqual(before);
});
