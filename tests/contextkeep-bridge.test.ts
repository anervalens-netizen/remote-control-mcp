import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const directories: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "rc-ck-")); directories.push(directory);
  const work = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const input = { command: "printf synthetic", idempotencyKey: "one" };
  const config = { directory, url: "http://127.0.0.1/mcp", token: "synthetic-token" };
  const status = { id: "synthetic-job", state: "completed", exitCode: 0, finishedAt: "2026-01-01T00:00:00.000Z" };
  const client = { jobStart: vi.fn(async () => ({ id: status.id })), jobStatus: vi.fn(async () => status) };
  const run = { id: work.runId, projectId: work.projectId, taskId: work.taskId, externalJobId: status.id, device: "fixture", identity: "owner", revision: 2, status: "running", verification: "pending" };
  const view = () => ({ task: { id: work.taskId, projectId: work.projectId }, runs: [{ ...run }], pagination: { totalRuns: 1, offset: 0, limit: 50 } });
  const call = vi.fn(async (name: string, _args: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    if (name === "get_task") return view();
    if (name === "observe_run") { run.status = "completed"; return { run: { ...run }, duplicate: false, applied: true, observationId: randomUUID() }; }
    return { run: { ...run } };
  });
  const make = (caller = call) => { const bridge = new ContextKeepBridge(client as unknown as AgentClient, config, caller); bridges.push(bridge); return bridge; };
  const journalPath = () => path.join(directory, readdirSync(directory).find(f => /^[a-f0-9]{64}\.json$/.test(f) && !f.startsWith("00000000"))!);
  const journal = () => JSON.parse(readFileSync(journalPath(), "utf8"));
  const update = (fn: (entry: any) => void) => { const entry = journal(); fn(entry); writeFileSync(journalPath(), JSON.stringify(entry)); };
  return { directory, work, input, config, status, client, run, call, make, journal, journalPath, update, view };
}

describe("ContextKeep journal and delivery guarantees", () => {
  it("starts independently of bridge downtime, persists backoff, and resumes after restart", async () => {
    const f = fixture(); let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const unavailable = vi.fn(async () => { throw new Error("synthetic-private-reply"); });
    const first = f.make(unavailable);
    await first.start("fixture", "user", f.input, f.work); await first.pump();
    expect(f.journal()).toMatchObject({ state: "tracking", attempts: 1, lastError: "transport", attachAcknowledged: false });
    const restarted = f.make(); await restarted.pump(); expect(f.call).not.toHaveBeenCalled();
    now += 2001; await restarted.pump();
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["attach_run_job", "get_task", "observe_run"]);
    expect(f.call.mock.calls[0]![1].inputHash).toBe(jobInputHash(f.input));
    expect(f.call.mock.calls[2]![1]).toMatchObject({ projectId: f.work.projectId, taskId: f.work.taskId, runId: f.work.runId, status: "completed", exitCode: 0, identity: "owner" });
    expect(f.journal()).toMatchObject({ state: "delivered", attachAcknowledged: true, observed: { state: "completed" } });
    await restarted.pump(); await restarted.start("fixture", "user", f.input, f.work);
    expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledTimes(3);
    const journal = readFileSync(f.journalPath(), "utf8");
    for (const privateText of [f.input.command, f.config.token, "synthetic-private-reply"]) expect(journal).not.toContain(privateText);
  });
  it("retains a lost start receipt and never replays, including after restart", async () => {
    const f = fixture(); f.client.jobStart.mockRejectedValue(new Error("lost receipt"));
    await expect(f.make().start("fixture", "user", f.input, f.work)).rejects.toThrow("job_start_uncertain");
    const restarted = f.make();
    await expect(restarted.start("fixture", "user", f.input, f.work)).rejects.toThrow("job_start_uncertain");
    await restarted.pump(); expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled();
    await expect(restarted.start("fixture", "user", { ...f.input, command: "different" }, f.work)).rejects.toThrow("contextkeep_job_conflict");
  });
  it("reserves exclusively across 20 concurrent same-key starts and retains delivered tombstones", async () => {
    const f = fixture(); const workers = Array.from({ length: 20 }, () => f.make());
    const results = await Promise.allSettled(workers.map(b => b.start("fixture", "user", f.input, f.work)));
    expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason.message).toContain("job_start_uncertain");
    await workers[0]!.pump(); await f.make().start("fixture", "user", f.input, f.work);
    expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(f.journal().state).toBe("delivered");
    await expect(workers[0]!.start("fixture", "user", { ...f.input, command: "changed" }, f.work)).rejects.toThrow("contextkeep_job_conflict");
  });
  it("isolates corrupt-before-healthy records and preserves corruption through restart", async () => {
    const f = fixture(); const bad = path.join(f.directory, "0".repeat(64) + ".json"); writeFileSync(bad, "{");
    const bridge = f.make(); await bridge.start("fixture", "user", f.input, f.work); await bridge.pump();
    expect(f.journal().state).toBe("delivered"); expect(readFileSync(bad, "utf8")).toBe("{");
    expect(bridge.diagnostics()).toMatchObject({ pendingCount: 0, corruptCount: 1 });
    await f.make().pump(); expect(f.client.jobStart).toHaveBeenCalledTimes(1);
  });
  for (const fault of ["json", "version", "key", "path", "scope", "field", "target", "symlink"]) {
    it(`never starts or repairs an invalid existing ${fault} journal`, async () => {
      const f = fixture(); const bridge = f.make(); await bridge.start("fixture", "user", f.input, f.work);
      if (fault === "json") writeFileSync(f.journalPath(), "{");
      else if (fault === "symlink") { const file = f.journalPath(); const evidence = path.join(f.directory, "evidence"); writeFileSync(evidence, readFileSync(file)); rmSync(file); symlinkSync(evidence, file); }
      else f.update(e => {
        if (fault === "version") e.version = 99;
        if (fault === "key") e.key = "a".repeat(64);
        if (fault === "path") e.key = "../outside";
        if (fault === "scope") e.correlation.taskId = "invalid";
        if (fault === "field") e.attempts = -1;
        if (fault === "target") e.target = "system";
      });
      const before = readFileSync(f.journalPath(), "utf8");
      await expect(f.make().start("fixture", "user", f.input, f.work)).rejects.toThrow("job_start_uncertain");
      if (fault !== "target") { await bridge.pump(); expect(bridge.diagnostics().corruptCount).toBe(1); }
      expect(readFileSync(f.journalPath(), "utf8")).toBe(before); expect(f.client.jobStart).toHaveBeenCalledTimes(1);
    });
  }
  it("migrates valid v1 tracking records without inventing an attach acknowledgement", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.update(e => { e.version = 1; for (const key of ["attachAcknowledged", "createdAt", "attempts", "nextAttemptAt"]) delete e[key]; });
    await f.make().pump(); expect(f.journal()).toMatchObject({ version: 2, attachAcknowledged: true, state: "delivered" });
    expect(f.client.jobStart).toHaveBeenCalledTimes(1);
  });
  it("retains a delivered v1 tombstone without trying to attach or start again", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.update(e => { e.version = 1; e.state = "delivered"; for (const key of ["attachAcknowledged", "createdAt", "attempts", "nextAttemptAt"]) delete e[key]; });
    const before = readFileSync(f.journalPath(), "utf8");
    await f.make().pump(); await f.make().start("fixture", "user", f.input, f.work);
    expect(f.client.jobStart).toHaveBeenCalledTimes(1); expect(f.call).not.toHaveBeenCalled();
    expect(readFileSync(f.journalPath(), "utf8")).toBe(before);
  });
  it("keeps empty tool success pending rather than acknowledging attach", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.call.mockImplementation(async name => name === "get_task" ? f.view() : {});
    await b.pump(); expect(f.journal()).toMatchObject({ state: "tracking", attachAcknowledged: false, lastError: "ack_mismatch" });
    expect(f.client.jobStatus).not.toHaveBeenCalled(); expect(f.call.mock.calls.map(c => c[0])).toEqual(["attach_run_job", "get_task"]);
  });
  it("leaves stale v1 terminal/verified runs pending when the hash proof is absent", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.update(e => { e.version = 1; for (const key of ["attachAcknowledged", "createdAt", "attempts", "nextAttemptAt"]) delete e[key]; });
    f.run.status = "completed"; f.run.verification = "passed";
    f.call.mockImplementation(async name => { if (name === "attach_run_job") throw new Error("expired synthetic lease"); return f.view(); });
    await f.make().pump(); expect(f.journal()).toMatchObject({ state: "tracking", lastError: "proof_missing", attachAcknowledged: false });
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["attach_run_job", "get_task"]);
  });
  it("persists attach and observation stages and reconciles verified remote completion without a write", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.call.mockImplementation(async name => {
      if (name === "get_task") return f.view();
      if (name === "observe_run") { f.run.status = "completed"; f.run.verification = "passed"; throw new Error("lost observation ACK"); }
      return { run: { ...f.run } };
    });
    await b.pump(); expect(f.journal()).toMatchObject({ state: "tracking", attachAcknowledged: true, observed: { state: "completed" } });
    f.update(e => { e.nextAttemptAt = 0; }); f.call.mockClear(); f.client.jobStatus.mockClear();
    await f.make().pump();
    expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_task"]); expect(f.client.jobStatus).not.toHaveBeenCalled();
    expect(f.journal().state).toBe("delivered"); expect(f.run.verification).toBe("passed");
  });
  for (const field of ["id", "projectId", "taskId", "externalJobId", "device", "identity", "inputHash", "status"]) {
    it(`rejects reconciliation with mismatching ${field}`, async () => {
      const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
      f.update(e => { e.attachAcknowledged = true; e.observed = { state: "completed", exitCode: 0, finishedAt: f.status.finishedAt }; });
      Object.assign(f.run, { status: "completed", [field]: field === "status" ? "failed" : "mismatch" });
      await b.pump(); expect(f.journal().state).toBe("tracking"); expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_task"]);
    });
  }
  it("reconciles an acknowledged terminal run when executor metadata is unavailable", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.update(e => { e.attachAcknowledged = true; }); f.run.status = "completed"; f.run.verification = "passed";
    f.client.jobStatus.mockRejectedValue(new Error("synthetic unavailable executor"));
    await b.pump(); expect(f.journal().state).toBe("delivered"); expect(f.journal().observed).toBeUndefined();
    expect(f.client.jobStatus).not.toHaveBeenCalled(); expect(f.call.mock.calls.map(c => c[0])).toEqual(["get_task"]);
  });
  it("reads bounded get_task pagination using its actual scope and shape", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.update(e => { e.attachAcknowledged = true; }); f.run.status = "completed";
    f.call.mockImplementation(async (_name, args) => ({ ...f.view(), runs: args.offset === 50 ? [f.run] : [], pagination: { offset: args.offset, limit: 50, totalRuns: 51 } }));
    await b.pump(); expect(f.call.mock.calls.map(c => c[1].offset)).toEqual([0, 50]); expect(f.journal().state).toBe("delivered");
  });
  it("leaves missing executor timestamps pending rather than fabricating evidence", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.status.finishedAt = ""; await b.pump(); expect(f.journal()).toMatchObject({ state: "tracking", lastError: "executor" });
    expect(f.journal().observed).toBeUndefined();
  });
  it("requires observation ACK fields, not only a run in a success object", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    f.call.mockImplementation(async name => name === "get_task" ? f.view() : { run: { ...f.run } });
    await b.pump(); expect(f.journal()).toMatchObject({ state: "tracking", lastError: "ack_mismatch", attachAcknowledged: true });
  });
  it("does not let one hung receipt starve a healthy one; shutdown bounds ignored cancellation", async () => {
    const f = fixture(); const b = f.make(); await b.start("fixture", "user", f.input, f.work);
    const other = { ...f.work, runId: randomUUID() };
    await b.start("fixture", "user", { ...f.input, idempotencyKey: "two" }, other);
    const original = f.call.getMockImplementation()!;
    f.call.mockImplementation((name, args, signal) => args.runId === other.runId ? new Promise(() => {}) : original(name, args, signal));
    const pumping = b.pump();
    await vi.waitFor(() => expect(b.diagnostics().pendingCount).toBe(1));
    const before = performance.now(); await b.close(); await pumping; expect(performance.now() - before).toBeLessThan(500);
    const diagnostic = JSON.stringify(b.diagnostics());
    for (const value of [f.work.leaseToken, f.config.token, f.input.command, f.work.runId, "fixture"]) expect(diagnostic).not.toContain(value);
    expect(b.diagnostics()).toMatchObject({ pendingCount: 1, corruptCount: 0, lastErrorCategories: { cancelled: 1 } });
  });
});
