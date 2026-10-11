import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { OperationObserver, operationsFor } from "../apps/mcp-server/src/operation-observer.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (closers.length) await closers.pop()!(); });
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-observations-")); closers.push(() => rm(root, { recursive: true, force: true })); return root; }

it("retains metadata across restart without claiming unfinished synchronous work is active", async () => {
  const root = await directory();
  const observer = new OperationObserver(root);
  const scope = randomUUID();
  const workflow = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: "private-lease" };
  const id = await observer.begin("exec", scope, "reused-id", "session-a", workflow);
  await observer.event(id!, { stage: "agent_dispatch", device: "lab", identity: "owner" });
  const restarted = new OperationObserver(root);
  expect(await restarted.inspect(id!)).toMatchObject({ state: "unknown", diagnosticScopeId: scope, clientAcceptance: "unknown", events: [{ stage: "handler_started" }, { stage: "agent_dispatch" }] });
  const next = await restarted.begin("exec", scope, "reused-id", "session-a");
  expect(next).not.toBe(id);
  const old = await restarted.inspect(id!), current = await restarted.inspect(next!);
  expect(old?.controllerInstanceId).not.toBe(current?.controllerInstanceId);
  expect(old?.requestHash).toBe(current?.requestHash);
  expect(old?.contextKeep?.taskId).toBe(workflow.taskId);
  expect(await readFile(path.join(root, `${id}.json`), "utf8")).not.toContain("private-lease");
});

it("keeps active/uncertain entries at capacity and prunes only expired terminal entries", async () => {
  const root = await directory();
  const observer = new OperationObserver(root, 2, 16384, 0);
  const active = await observer.begin("exec", undefined);
  const terminal = await observer.begin("exec", undefined);
  expect(await observer.begin("exec", undefined)).toBeUndefined();
  await observer.finish(terminal!, { code: 7, signal: null, timedOut: false }, true, false);
  expect((await observer.inspect(terminal!))?.executionOutcome).toBe("exit_nonzero");
  expect(await observer.begin("exec", undefined)).toBeTypeOf("string");
  expect(await observer.inspect(active!)).toMatchObject({ state: "running" });
  expect(await observer.inspect(terminal!)).toBeNull();
});

it("bounds metadata bytes and reports disk failure without rejecting observations", async () => {
  const bounded = new OperationObserver(undefined, 100, 1000);
  await bounded.begin("exec", undefined);
  await bounded.begin("exec", undefined);
  await bounded.begin("exec", undefined);
  expect((await bounded.snapshot()).coverage).toMatchObject({ partial: true, faults: ["journal_capacity"] });
  const root = await directory();
  const file = path.join(root, "not-a-directory"); await writeFile(file, "preserve");
  const broken = new OperationObserver(file);
  const id = await broken.begin("exec", undefined);
  await expect(broken.finish(id!, {}, true, false)).resolves.toBeUndefined();
  expect((await broken.snapshot()).coverage.partial).toBe(true);
  expect(await readFile(file, "utf8")).toBe("preserve");
});

it("retains corrupt evidence and independently scopes cursor-safe pages", async () => {
  const root = await directory(); const corrupt = `${randomUUID()}.json`; await writeFile(path.join(root, corrupt), "broken");
  const observer = new OperationObserver(root);
  const a = randomUUID(), b = randomUUID();
  const ids = [await observer.begin("exec", a), await observer.begin("exec", b), await observer.begin("exec", a)];
  const first = await observer.snapshot({ diagnosticScopeId: a, limit: 1 });
  const second = await observer.snapshot({ diagnosticScopeId: a, cursor: first.nextCursor!, limit: 1 });
  expect(first.items).toHaveLength(1); expect(second.items).toHaveLength(1);
  expect(first.items[0]!.traceId).not.toBe(second.items[0]!.traceId);
  expect([first.items[0]!.traceId, second.items[0]!.traceId].sort()).toEqual([ids[0], ids[2]].sort());
  expect(first.coverage).toMatchObject({ partial: true, faults: ["journal_corrupt"] });
  expect(await readFile(path.join(root, corrupt), "utf8")).toBe("broken");
});

it("tracks real RPC/job references, strips scope before dispatch, and excludes 100 UI refreshes from recovery", async () => {
  const app = Fastify();
  let dispatched: unknown;
  app.post("/v1/jobs/start", async request => { dispatched = request.body; return { id: "synthetic-job", state: "running", command: "private-fixture", stdout: "private-output" }; });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const agent = new AgentClient([{ name: "lab-primary", aliases: ["lab"], url }]);
  const server = new McpServer({ name: "synthetic", version: "1" }); registerTools(server, agent);
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const scope = randomUUID();
  const result = await client.callTool({ name: "job_start", arguments: { device: "lab", command: "private-fixture", env: { KEY: "private-value" }, diagnosticScopeId: scope } });
  expect(result.isError).not.toBe(true);
  expect(dispatched).not.toHaveProperty("diagnosticScopeId");
  const content = result.structuredContent as any;
  const observed = await operationsFor(agent).inspect(content.operationTrace.traceId);
  expect(observed).toMatchObject({ diagnosticScopeId: scope, state: "returned", requestSucceeded: true, jobs: [{ device: "lab-primary", identity: "root", jobId: "synthetic-job" }], events: [{ stage: "handler_started" }, { stage: "agent_dispatch" }, { stage: "agent_response" }, { stage: "handler_returned" }] });
  expect(JSON.stringify(observed)).not.toMatch(/private-fixture|private-output|private-value/);
  for (let i = 0; i < 100; i++) {
    const refresh = await client.callTool({ name: "dashboard_snapshot", arguments: { includeFleet: false } });
    expect(refresh.isError).not.toBe(true); expect(refresh.structuredContent).not.toHaveProperty("resultRecovery");
  }
  const recovery = await client.callTool({ name: "result_recover", arguments: { id: content.resultRecovery.id } });
  expect(recovery.isError).not.toBe(true);
  expect((await operationsFor(agent).snapshot()).items).toHaveLength(1);

});

it("does not expire uncertain effects or durable job references after the handler returns", async () => {
  const root = await directory();
  const observer = new OperationObserver(root, 10, 32768, 0);
  const uncertain = await observer.begin("exec", undefined);
  await observer.finish(uncertain!, { code: null, cancellationRequested: true }, true, false);
  const failed = await observer.begin("exec", undefined);
  await observer.event(failed!, { stage: "agent_dispatch", device: "lab", identity: "owner" });
  await observer.finish(failed!, undefined, false, false);
  const job = await observer.begin("job_start", undefined);
  await observer.event(job!, { stage: "agent_response", device: "lab", identity: "owner", successful: true }, { device: "lab", identity: "owner", jobId: "durable-job" });
  await observer.finish(job!, { state: "running" }, true, false);
  const restarted = new OperationObserver(root, 10, 32768, 0);
  await restarted.begin("info", undefined);
  expect(await restarted.inspect(uncertain!)).toMatchObject({ state: "unknown", executionOutcome: "uncertain" });
  expect(await restarted.inspect(failed!)).toMatchObject({ state: "unknown", requestSucceeded: false });
  expect(await restarted.inspect(job!)).toMatchObject({ state: "returned", jobs: [{ jobId: "durable-job" }] });
});

it("expires job observations only after an authoritative terminal read, preserving lost jobs", async () => {
  const observer = new OperationObserver(undefined, 10, 32768, 0);
  const reference = { device: "lab", identity: "owner" as const, jobId: "job" };
  const id = await observer.begin("job_start", undefined);
  await observer.event(id!, { stage: "agent_response" }, reference);
  await observer.finish(id!, {}, true, false);
  await observer.reconcileJob(reference, "lost");
  await observer.begin("info", undefined);
  expect(await observer.inspect(id!)).not.toBeNull();
  await observer.reconcileJob({ ...reference, identity: "root" }, "completed");
  await observer.begin("info", undefined);
  expect(await observer.inspect(id!)).not.toBeNull();
  await observer.reconcileJob(reference, "completed");
  await observer.begin("info", undefined);
  expect(await observer.inspect(id!)).toBeNull();
});

it("recycles safe entries under pressure without waiting for retention", async () => {
  const observer = new OperationObserver(await directory(), 1);
  const id = (await observer.begin("device_info", undefined))!;
  await observer.finish(id, {}, true, false);
  expect(await observer.begin("exec", undefined)).toBeTypeOf("string");
  expect(await observer.inspect(id)).toBeNull();
  expect(observer.coverage().counters.evicted).toBe(1);
});

it("preserves job locator and completion when updates cross the admission byte budget", async () => {
  const root = await directory();
  const observer = new OperationObserver(root, 2, 1000);
  const id = (await observer.begin("job_start", undefined))!;
  const job = { device: "d".repeat(256), identity: "root" as const, jobId: "j".repeat(256) };
  await observer.event(id, { stage: "agent_response" }, job);
  await observer.finish(id, {}, true, false, randomUUID());
  expect(await new OperationObserver(root, 2, 1000).inspect(id)).toMatchObject({ state: "returned", jobs: [job], persistence: "confirmed" });
  expect(observer.coverage().retainedBytes).toBeGreaterThan(1000);
});

it("keeps terminal evidence despite stale responses and reconciles failed wait observations", async () => {
  const observer = new OperationObserver(await directory());
  const id = (await observer.begin("job_wait", undefined))!;
  const job = { device: "lab", identity: "root" as const, jobId: "job" };
  await observer.event(id, { stage: "agent_dispatch" }, job);
  await observer.finish(id, undefined, false, true);
  await observer.reconcileJob(job, "completed");
  await observer.reconcileJob(job, "running");
  expect(await observer.inspect(id)).toMatchObject({ state: "returned", terminalJobs: [job], requestSucceeded: false });
});

it("tolerates already removed expired files and retains coverage across restart", async () => {
  const root = await directory(); const observer = new OperationObserver(root, 1, 16384, 0);
  const id = (await observer.begin("exec", undefined))!;
  await observer.begin("exec", undefined);
  await observer.finish(id, { code: 0 }, true, false);
  await rm(path.join(root, `${id}.json`));
  expect(await observer.begin("exec", undefined)).toBeTypeOf("string");
  expect((await new OperationObserver(root).snapshot()).coverage.counters.admissionRefused).toBe(1);
});

it("recovers the only locator from an interrupted publication temporary", async () => {
  const root = await directory(); const observer = new OperationObserver(root);
  const id = (await observer.begin("job_start", undefined))!;
  const saved = JSON.parse(await readFile(path.join(root, `${id}.json`), "utf8"));
  saved.jobs = [{ device: "lab", identity: "root", jobId: "retained-job" }];
  const temp = `${id}.json.${randomUUID()}.tmp`;
  await writeFile(path.join(root, temp), JSON.stringify(saved));
  const reloaded = new OperationObserver(root);
  expect(await reloaded.inspect(id)).toMatchObject({ state: "unknown", jobs: saved.jobs });
  expect(await readdir(root)).not.toContain(temp);
  expect(await new OperationObserver(root).inspect(id)).toMatchObject({ jobs: saved.jobs });
});


it("retains a synchronized temporary and RAM uncertainty after publication failure", async () => {
  const root = await directory(); const observer = new OperationObserver(root);
  const id = (await observer.begin("job_start", undefined))!;
  const rename = fs.rename;
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from,to) => {
    if (String(to).endsWith(`${id}.json`)) throw Object.assign(new Error("synthetic failure"), {code:"EIO"});
    return rename(from,to);
  });
  const job = {device:"lab",identity:"root" as const,jobId:"only-locator"};
  await observer.event(id,{stage:"agent_response"},job);
  expect(await observer.inspect(id)).toMatchObject({jobs:[job],persistence:"unconfirmed"});
  expect((await readdir(root)).some(f=>f.endsWith(".tmp") && f.startsWith(id))).toBe(true);
  spy.mockRestore();
  const restored = new OperationObserver(root);
  expect(await restored.inspect(id)).toMatchObject({jobs:[job],state:"unknown"});
});

it("serializes delayed publication before finalization without dropping the locator", async () => {
  const root = await directory(); const observer = new OperationObserver(root);
  const id = (await observer.begin("job_start", undefined))!;
  const rename = fs.rename; let release!:()=>void; let entered!:()=>void;
  const gate = new Promise<void>(r=>{release=r}); const started = new Promise<void>(r=>{entered=r});
  const spy = vi.spyOn(fs,"rename").mockImplementation(async (from,to)=>{
    if (String(to).endsWith(`${id}.json`)) { entered(); await gate; }
    return rename(from,to);
  });
  const job = {device:"lab",identity:"root" as const,jobId:"ordered-locator"};
  const event = observer.event(id,{stage:"agent_response"},job); await started;
  const finish = observer.finish(id,{},true,false);
  release(); await Promise.all([event,finish]); spy.mockRestore();
  expect(await new OperationObserver(root).inspect(id)).toMatchObject({state:"returned",jobs:[job]});
});

it("does not remove an orphan temporary when there is no room to publish its locator", async () => {
  const root = await directory(); const observer = new OperationObserver(root);
  const id = (await observer.begin("job_start", undefined))!;
  const file = path.join(root, `${id}.json`);
  const saved = JSON.parse(await readFile(file,"utf8"));
  saved.jobs = [{device:"lab",identity:"root",jobId:"orphan-locator"}];
  const temporary = `${id}.json.${randomUUID()}.tmp`;
  await writeFile(path.join(root,temporary),JSON.stringify(saved)); await rm(file);
  const reloaded = new OperationObserver(root,1,1);
  expect((await reloaded.snapshot()).coverage.faults).toContain("temporary_reconciliation_required");
  expect(await readdir(root)).toContain(temporary);
});
