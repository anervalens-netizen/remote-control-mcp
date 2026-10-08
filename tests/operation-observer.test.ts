import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, expect, it } from "vitest";
import { OperationObserver, operationsFor } from "../apps/mcp-server/src/operation-observer.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
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
