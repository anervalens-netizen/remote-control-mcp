import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, fsyncSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:fs", async original => { const actual = await original<typeof import("node:fs")>(); return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), writeFileSync: vi.fn(actual.writeFileSync) }; });
import { ContextKeepBridge } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { DurableBatchStore } from "../apps/mcp-server/src/durable-batch.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())); vi.restoreAllMocks(); vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync); vi.mocked(writeFileSync).mockImplementation(actualFs.writeFileSync); dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
it.each(["ENOSPC", "write", "fsync"])("%s before reservation persistence prevents CK and batch effects", async fault => {
  const root = mkdtempSync(path.join(os.tmpdir(), "io-before-")); dirs.push(root);
  const client = { devices: [{ name: "fixture", url: "http://127.0.0.1:1" }], jobStart: vi.fn(), info: vi.fn() } as unknown as AgentClient;
  const b = new ContextKeepBridge(client, { directory: root, url: "http://127.0.0.1", token: "synthetic" }); bridges.push(b);
  const store = new DurableBatchStore(client, root);
  const error = Object.assign(new Error("synthetic fault"), { code: fault === "ENOSPC" ? "ENOSPC" : "EIO" });
  if (fault === "fsync") vi.mocked(fsyncSync).mockImplementation(() => { throw error; }); else vi.mocked(writeFileSync).mockImplementation(() => { throw error; });
  await expect(b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() })).rejects.toThrow();
  await expect(store.start("one", [{ device: "fixture", target: "system", request: { command: "synthetic" } }])).rejects.toThrow();
  expect(client.jobStart).not.toHaveBeenCalled();
});
it("ACK is not claimed durable when fsync fails; restart retains uncertainty and cannot execute again", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "io-ack-")); dirs.push(root);
  const work = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const run = { id: work.runId, projectId: work.projectId, taskId: work.taskId, externalJobId: "job", device: "fixture", identity: "owner", revision: 2, status: "completed", verification: "failed" };
  const client = { jobStart: vi.fn(async () => ({ id: "job" })), jobStatus: vi.fn(async () => ({ id: "job", state: "completed" })) } as unknown as AgentClient;
  const b = new ContextKeepBridge(client, { directory: root, url: "http://127.0.0.1", token: "synthetic" }, async name => {
    if (name === "attach_run_job") { vi.mocked(fsyncSync).mockImplementation(() => { throw Object.assign(new Error("synthetic"), { code: "ENOSPC" }); }); return { run }; }
    return { task: {}, runs: [run], pagination: { offset: 0, limit: 50, totalRuns: 1 } };
  }); bridges.push(b);
  await b.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, work); await b.pump();
  const key = createHash("sha256").update(JSON.stringify(["fixture", "user", "one"])).digest("hex");
  expect(JSON.parse(readFileSync(path.join(root, key + ".json"), "utf8"))).toMatchObject({ state: "tracking", attachAcknowledged: false });
  expect(b.diagnostics()).toMatchObject({ pendingCount: 1, lastErrorCategories: { journal: 1 } });
  vi.mocked(fsyncSync).mockImplementation(actualFs.fsyncSync); await b.close();
  const restarted = new ContextKeepBridge(client, { directory: root, url: "http://127.0.0.1", token: "synthetic" }); bridges.push(restarted);
  await restarted.start("fixture", "user", { command: "synthetic", idempotencyKey: "one" }, work); expect(client.jobStart).toHaveBeenCalledTimes(1);
});
