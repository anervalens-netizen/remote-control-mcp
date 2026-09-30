import { createHash, randomUUID } from "node:crypto";
import { constants, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import * as journal from "../apps/mcp-server/src/contextkeep-journal.ts";

vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, openSync: vi.fn(fs.openSync), readdirSync: vi.fn(fs.readdirSync) };
});

const directories: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  const directory = mkdtempSync(path.join(tmpdir(), "rc-ck-index-")); directories.push(directory);
  const input = (key: string) => ({ command: "printf synthetic", idempotencyKey: key });
  const runs = new Map<string, {
    id: string; projectId: string; taskId: string; externalJobId: string; device: string;
    identity: string; revision: number; status: string; verification: string;
  }>();
  function entry(label: string, state: journal.Entry["state"] = "tracking"): journal.Entry {
    const correlation = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
    const value: journal.Entry = {
      version: 2, key: createHash("sha256").update(JSON.stringify(["fixture", "user", label])).digest("hex"),
      hash: jobInputHash(input(label)), device: "fixture", target: "user", correlation, state,
      attachKey: randomUUID(), observeKey: randomUUID(), attachAcknowledged: state !== "job_start_uncertain",
      createdAt: Date.now() - 10_000, attempts: 0, nextAttemptAt: 0,
      ...(state === "job_start_uncertain" ? {} : { jobId: "synthetic-job" }),
    };
    runs.set(correlation.runId, {
      id: correlation.runId, projectId: correlation.projectId, taskId: correlation.taskId,
      externalJobId: "synthetic-job", device: "fixture", identity: "owner", revision: 2,
      status: "completed", verification: "pending",
    });
    return value;
  }
  const file = (entry: journal.Entry) => path.join(directory, entry.key + ".json");
  const write = (entry: journal.Entry) => writeFileSync(file(entry), JSON.stringify(entry));
  const read = (entry: journal.Entry): journal.Entry => JSON.parse(readFileSync(file(entry), "utf8"));
  const opens = (entries: journal.Entry[]) => {
    const files = new Set(entries.map(file));
    return vi.mocked(openSync).mock.calls.filter(([name, flags]) =>
      typeof name === "string" && files.has(name) && flags === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))).length;
  };
  const scans = () => vi.mocked(readdirSync).mock.calls.filter(([name]) => name === directory).length;
  const client = {
    jobStart: vi.fn(async () => ({ id: "synthetic-job" })),
    jobStatus: vi.fn(async () => ({ id: "synthetic-job", state: "completed", exitCode: 0, finishedAt: "2026-01-01T00:00:00.000Z" })),
  };
  const call = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === "get_task") return {
      task: { id: args.taskId }, runs: [...runs.values()].filter(run => run.taskId === args.taskId).map(run => ({ ...run })),
      pagination: { totalRuns: 1, offset: 0, limit: 50 },
    };
    const run = runs.get(String(args.runId))!;
    if (name === "observe_run") {
      run.status = String(args.status);
      return { run: { ...run }, duplicate: false, applied: true, observationId: randomUUID() };
    }
    return { run: { ...run } };
  });
  const make = () => {
    const bridge = new ContextKeepBridge(client as unknown as AgentClient, { directory, url: "http://127.0.0.1/mcp", token: "synthetic" }, call);
    bridges.push(bridge); return bridge;
  };
  return { directory, input, runs, entry, file, write, read, opens, scans, client, call, make };
}

it("does not reopen historical tombstones during repeated idle pumps or diagnostics, and indexes local starts immediately", async () => {
  const f = fixture();
  const history = Array.from({ length: 512 }, (_, i) => f.entry(`history-${i}`, "delivered"));
  history.forEach(f.write);
  const uncertain = f.entry("uncertain", "job_start_uncertain"); f.write(uncertain);
  const bridge = f.make();
  expect(bridge.diagnostics()).toEqual({ pendingCount: 1, oldestPendingMs: 10_000, corruptCount: 0, lastErrorCategories: {} });
  expect(f.opens(history)).toBe(512);
  for (let tick = 1; tick <= 29; tick++) {
    await vi.advanceTimersByTimeAsync(2000); await bridge.pump();
    expect(bridge.diagnostics().oldestPendingMs).toBe(10_000 + tick * 2000);
  }
  expect(f.opens(history)).toBe(512); expect(f.opens([uncertain])).toBe(1); expect(f.scans()).toBe(1);
  expect(f.call).not.toHaveBeenCalled(); expect(f.client.jobStart).not.toHaveBeenCalled();

  const local = f.entry("local");
  await bridge.start("fixture", "user", f.input("local"), local.correlation);
  expect(bridge.diagnostics().pendingCount).toBe(2);
  await bridge.pump();
  expect(f.read(local).state).toBe("delivered"); expect(bridge.diagnostics().pendingCount).toBe(1);
  expect(f.opens(history)).toBe(512); expect(f.scans()).toBe(1);
  expect(f.client.jobStart).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(2000); await bridge.pump();
  expect(f.opens(history)).toBe(1024); expect(f.scans()).toBe(2);
  for (const tombstone of history) expect(readFileSync(f.file(tombstone), "utf8")).toBe(JSON.stringify(tombstone));
});

it("spaces reconciliation from the end of a slow scan instead of scanning again on the next idle tick", async () => {
  const f = fixture(), entry = f.entry("history", "delivered"); f.write(entry);
  const read = journal.readEntry;
  vi.spyOn(journal, "readEntry").mockImplementationOnce((...args) => {
    vi.setSystemTime(Date.now() + 61_000);
    return read(...args);
  });
  const bridge = f.make(); await bridge.pump();
  for (let tick = 0; tick < 29; tick++) {
    await vi.advanceTimersByTimeAsync(2000); await bridge.pump(); bridge.diagnostics();
  }
  expect(f.scans()).toBe(1); expect(f.opens([entry])).toBe(1);
  await vi.advanceTimersByTimeAsync(2000); await bridge.pump();
  expect(f.scans()).toBe(2); expect(f.opens([entry])).toBe(2);
});

it("discovers external additions and repairs of delivered, uncertain and corrupt records at the reconciliation deadline", async () => {
  const f = fixture();
  const delivered = f.entry("delivered", "delivered"), uncertain = f.entry("uncertain", "job_start_uncertain"), corrupt = f.entry("corrupt");
  f.write(delivered); f.write(uncertain); writeFileSync(f.file(corrupt), "{");
  const bridge = f.make(); await bridge.pump();
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, corruptCount: 1 });
  f.write({ ...delivered, state: "tracking" });
  f.write({ ...uncertain, state: "tracking", jobId: "synthetic-job", attachAcknowledged: true });
  f.write(corrupt);
  const added = f.entry("external"); f.write(added);
  await vi.advanceTimersByTimeAsync(59_999); await bridge.pump();
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, corruptCount: 1 });
  expect(f.call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await bridge.pump();
  for (const entry of [delivered, uncertain, corrupt, added]) expect(f.read(entry).state).toBe("delivered");
  expect(bridge.diagnostics()).toEqual({ pendingCount: 0, corruptCount: 0, oldestPendingMs: 0, lastErrorCategories: {} });
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(Array(4).fill("get_task"));
  expect(f.client.jobStart).not.toHaveBeenCalled();
});

it("uses strict same-key start reads to discover explicit repairs immediately and never trusts a cached tombstone", async () => {
  const f = fixture(), entry = f.entry("existing", "delivered"); f.write(entry);
  const bridge = f.make(); await bridge.pump();
  writeFileSync(f.file(entry), "{");
  await expect(bridge.start("fixture", "user", f.input("existing"), entry.correlation)).rejects.toThrow("job_start_uncertain");
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 0, corruptCount: 1 });
  const { jobId: _jobId, ...uncertain } = entry;
  f.write({ ...uncertain, state: "job_start_uncertain", attachAcknowledged: false });
  await expect(bridge.start("fixture", "user", f.input("existing"), entry.correlation)).rejects.toThrow("job_start_uncertain");
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, corruptCount: 0 });
  f.write({ ...entry, state: "tracking" });
  await bridge.start("fixture", "user", f.input("existing"), entry.correlation);
  await bridge.pump(); expect(f.read(entry).state).toBe("delivered");
  await expect(bridge.start("fixture", "user", { ...f.input("existing"), command: "changed" }, entry.correlation)).rejects.toThrow("contextkeep_job_conflict");
  expect(f.scans()).toBe(1); expect(f.client.jobStart).not.toHaveBeenCalled();
});

it("schedules durable retry deadlines without reopening waiting entries and rereads disk before acting", async () => {
  const f = fixture(), entry = f.entry("retry");
  entry.nextAttemptAt = Date.now() + 10_000; entry.attempts = 3; entry.lastError = "transport"; f.write(entry);
  const bridge = f.make(); await bridge.pump();
  for (let tick = 0; tick < 4; tick++) { await vi.advanceTimersByTimeAsync(2000); await bridge.pump(); }
  expect(f.opens([entry])).toBe(1); expect(f.call).not.toHaveBeenCalled();
  expect(bridge.diagnostics().lastErrorCategories).toEqual({ transport: 1 });
  // An external edit after indexing must still fence a now-due attempt.
  entry.nextAttemptAt += 10_000; f.write(entry);
  await vi.advanceTimersByTimeAsync(2000); await bridge.pump();
  expect(f.opens([entry])).toBe(2); expect(f.call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9999); await bridge.pump(); expect(f.opens([entry])).toBe(2);
  await vi.advanceTimersByTimeAsync(1); await bridge.pump();
  expect(f.opens([entry])).toBe(3); expect(f.read(entry).state).toBe("delivered");
  expect(bridge.diagnostics().lastErrorCategories).toEqual({});
});

it.each(["attach", "delivered"])("retains pending work and retry backoff across reconciliation when %s saves fail", async stage => {
  const f = fixture(), entry = f.entry("save-failure");
  entry.attempts = 6;
  if (stage === "attach") { entry.attachAcknowledged = false; f.runs.get(entry.correlation.runId)!.status = "running"; }
  f.write(entry);
  const save = journal.saveEntry;
  let fail = true;
  vi.spyOn(journal, "saveEntry").mockImplementation((...args) => {
    if (fail) throw new Error("synthetic write failure");
    save(...args);
  });
  const bridge = f.make(); await bridge.pump();
  expect(f.read(entry)).toEqual(entry);
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, lastErrorCategories: { journal: 1 } });
  const calls = f.call.mock.calls.length, reads = f.opens([entry]);
  await vi.advanceTimersByTimeAsync(2000); await bridge.pump(); expect(f.opens([entry])).toBe(reads);
  await vi.advanceTimersByTimeAsync(58_000); await bridge.pump();
  expect(f.opens([entry])).toBe(reads + 1); expect(f.call).toHaveBeenCalledTimes(calls);
  expect(bridge.diagnostics().lastErrorCategories).toEqual({ journal: 1 });
  fail = false;
  await vi.advanceTimersByTimeAsync(67_999); await bridge.pump(); expect(f.call).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1); await bridge.pump();
  expect(f.read(entry)).toMatchObject({ state: "delivered", attachAcknowledged: true });
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 0, lastErrorCategories: {} });
  if (stage === "attach") expect(f.call.mock.calls.filter(([name]) => name === "attach_run_job")).toHaveLength(2);
  expect(f.client.jobStart).not.toHaveBeenCalled();
});

it("retains an uncertain reservation when saving the start receipt fails and discovers a later external repair", async () => {
  const f = fixture(), entry = f.entry("receipt");
  const save = journal.saveEntry;
  vi.spyOn(journal, "saveEntry").mockImplementation((directory, value, create) => {
    if (!create) throw new Error("synthetic write failure");
    save(directory, value, create);
  });
  const bridge = f.make();
  await expect(bridge.start("fixture", "user", f.input("receipt"), entry.correlation)).rejects.toThrow("job_start_uncertain");
  await bridge.pump(); expect(bridge.diagnostics().pendingCount).toBe(1);
  await expect(bridge.start("fixture", "user", f.input("receipt"), entry.correlation)).rejects.toThrow("job_start_uncertain");
  expect(f.read(entry).state).toBe("job_start_uncertain"); expect(f.call).not.toHaveBeenCalled();
  vi.mocked(journal.saveEntry).mockRestore(); f.write(entry);
  await vi.advanceTimersByTimeAsync(60_000); await bridge.pump();
  expect(f.read(entry).state).toBe("delivered"); expect(f.client.jobStart).toHaveBeenCalledTimes(1);
});

it("throttles failed directory reconciliation, keeps local progress and refreshes diagnostic errors and removals", async () => {
  const f = fixture(), local = f.entry("local"), external = f.entry("external", "job_start_uncertain"), corrupt = f.entry("corrupt");
  f.write(external); writeFileSync(f.file(corrupt), "{");
  const bridge = f.make(); await bridge.start("fixture", "user", f.input("local"), local.correlation);
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error("synthetic directory failure"); });
  await bridge.pump(); expect(f.read(local).state).toBe("delivered");
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 0, lastErrorCategories: { journal: 1 } });
  await vi.advanceTimersByTimeAsync(2000); await bridge.pump(); expect(f.scans()).toBe(1);
  await vi.advanceTimersByTimeAsync(58_000);
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, corruptCount: 1, oldestPendingMs: 70_000, lastErrorCategories: {} });
  // Only synthetic fixtures are removed; production tombstones remain permanent.
  rmSync(f.file(external)); rmSync(f.file(corrupt));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(bridge.diagnostics()).toEqual({ pendingCount: 0, corruptCount: 0, oldestPendingMs: 0, lastErrorCategories: {} });
});

it("clears worker and attempt timers on shutdown and ignores a late delivery response", async () => {
  const f = fixture(), entry = f.entry("shutdown"); f.write(entry);
  let finish!: (value: unknown) => void;
  const response = new Promise<unknown>(resolve => { finish = resolve; });
  f.call.mockImplementation(() => response);
  const bridge = f.make(); bridge.startWorker(); bridge.startWorker();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(2000); expect(f.call).toHaveBeenCalledTimes(1);
  await bridge.close(); expect(vi.getTimerCount()).toBe(0);
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, lastErrorCategories: { cancelled: 1 } });
  const before = readFileSync(f.file(entry), "utf8"), reads = f.opens([entry]), scans = f.scans();
  finish({}); await response; await Promise.resolve();
  await vi.advanceTimersByTimeAsync(600_000); await bridge.pump(); bridge.startWorker();
  expect(vi.getTimerCount()).toBe(0); expect(f.opens([entry])).toBe(reads); expect(f.scans()).toBe(scans);
  expect(readFileSync(f.file(entry), "utf8")).toBe(before); expect(f.call).toHaveBeenCalledTimes(1);
});
