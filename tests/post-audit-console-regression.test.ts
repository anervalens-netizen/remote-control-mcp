import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { operationsFor } from "../apps/mcp-server/src/operation-observer.ts";
import { STRUCTURED_CONTENT_MAX_BYTES } from "../apps/mcp-server/src/tool-contract-defaults.ts";

const closers: (() => Promise<unknown>)[] = [];
beforeEach(() => { vi.stubEnv("RCMCP_STATE_DIR", ""); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (closers.length) await closers.pop()!(); });
async function harness(agent: AgentClient) {
  const server = new McpServer({ name: "synthetic", version: "1" });
  registerTools(server, agent);
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}
async function fixture(state = "completed") {
  const app = Fastify();
  app.post("/v1/jobs/start", async () => ({ id: "fixture-job", state: "running" }));
  for (const route of ["status", "follow", "cancel"]) app.post("/v1/jobs/" + route, async () => ({ id: "fixture-job", state }));
  app.post("/v1/jobs/output", async () => ({ id: "fixture-job", stream: "stdout", offset: 0, eof: true, data: "", nextOffset: 0, totalBytes: 0, encoding: "utf8" }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => app.close());
  return new AgentClient([{ name: "lab", aliases: ["fixture"], url }]);
}

it("keeps the delivered operation trace in the exact recovered receipt without another dispatch", async () => {
  const agent = await fixture();
  const start = vi.spyOn(agent, "jobStart");
  const client = await harness(agent);
  const response = await client.callTool({ name: "job_start", arguments: { device: "lab", command: "synthetic" } });
  expect(response.isError).not.toBe(true);
  const receipt = response.structuredContent as any;
  const recovered = await client.callTool({ name: "result_recover", arguments: { id: receipt.resultRecovery.id } });
  const page = recovered.structuredContent as any;
  expect(page.eof).toBe(true);
  const original = JSON.parse(Buffer.from(page.data, "base64").toString("utf8"));
  expect(original.structuredContent.operationTrace).toEqual(receipt.operationTrace);
  expect(start).toHaveBeenCalledTimes(1);
});

it.each(["status", "follow", "cancel"])("reconciles terminal agent evidence through ordinary %s reads", async route => {
  const agent = await fixture();
  const client = await harness(agent);
  const started = await client.callTool({ name: "job_start", arguments: { device: "fixture", command: "synthetic" } });
  const traceId = (started.structuredContent as any).operationTrace.traceId;
  await agent.requestRoute("fixture", "/v1/jobs/" + route, { id: "fixture-job" });
  expect(await operationsFor(agent).inspect(traceId)).toMatchObject({
    terminalJobs: [{ device: "lab", identity: "root", jobId: "fixture-job" }],
  });
});

it.each(["lost", "running", "cancelling"])("does not treat %s or output EOF as proof of termination", async state => {
  const agent = await fixture(state);
  const client = await harness(agent);
  const started = await client.callTool({ name: "job_start", arguments: { device: "lab", command: "synthetic" } });
  const traceId = (started.structuredContent as any).operationTrace.traceId;
  await agent.jobOutput("lab", { id: "fixture-job" });
  await agent.jobStatus("lab", "fixture-job");
  expect((await operationsFor(agent).inspect(traceId))?.terminalJobs ?? []).toEqual([]);
});

it("pages large fleets and operation metadata within the wire budget without evicting execution receipts", async () => {
  const inventory = Array.from({ length: 120 }, (_, i) => ({ name: "lab-" + String(i).padStart(3, "0"), url: "http://127.0.0.1:1" }));
  const agent = new AgentClient(inventory);
  vi.spyOn(agent, "info").mockResolvedValue({ runtime: { ready: true, sha: "a".repeat(40), extra: "x".repeat(80_000) } });
  vi.spyOn(agent, "requestRoute").mockResolvedValue({ totalMemoryBytes: 100, freeMemoryBytes: 25 });
  const observer = operationsFor(agent);
  for (let i = 0; i < 30; i++) {
    const id = await observer.begin("job_start_many", undefined);
    for (let j = 0; j < 40; j++) await observer.event(id!, { stage: "agent_response" },
      { device: "synthetic-" + "d".repeat(220), identity: "root", jobId: "j".repeat(240) + j });
    await observer.finish(id!, {}, true, false);
  }
  const client = await harness(agent);
  const seen = new Set<string>();
  let fleetCursor: string | undefined;
  do {
    const result = await client.callTool({ name: "dashboard_snapshot", arguments: { fleetCursor } });
    expect(result.isError).not.toBe(true);
    const value = result.structuredContent as any;
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(STRUCTURED_CONTENT_MAX_BYTES);
    expect(value).not.toHaveProperty("resultRecovery");
    expect(value.fleet.totalConfigured).toBe(120);
    for (const row of value.fleet.devices) { expect(seen.has(row.device)).toBe(false); seen.add(row.device); }
    fleetCursor = value.fleet.nextCursor ?? undefined;
  } while (fleetCursor);
  expect(seen.size).toBe(120);
  const operations = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await client.callTool({ name: "dashboard_snapshot", arguments: { includeFleet: false, cursor } });
    expect(result.isError).not.toBe(true);
    const value = result.structuredContent as any;
    for (const op of value.operations.items) { expect(operations.has(op.traceId)).toBe(false); operations.add(op.traceId); }
    cursor = value.operations.nextCursor ?? undefined;
  } while (cursor);
  expect(operations.size).toBe(30);
  const emptyPage = await client.callTool({ name: "dashboard_snapshot", arguments: { fleetCursor: "zzz" } });
  expect((emptyPage.structuredContent as any).fleet.devices).toEqual([]);
  const retained = await client.callTool({ name: "result_recover", arguments: {} });
  expect((retained.structuredContent as any).total).toBe(0);
});


it("carries authoritative terminal proof to a later ordinary output observation", async () => {
  const agent = await fixture();
  const client = await harness(agent);
  await client.callTool({ name: "job_start", arguments: { device: "lab", command: "synthetic" } });
  await client.callTool({ name: "job_status", arguments: { device: "lab", id: "fixture-job" } });
  const output = await client.callTool({ name: "job_output", arguments: { device: "lab", id: "fixture-job" } });
  expect(output.isError).not.toBe(true);
  const traceId = (output.structuredContent as any).operationTrace.traceId;
  expect(await operationsFor(agent).inspect(traceId)).toMatchObject({
    terminalJobs: [{ device: "lab", identity: "root", jobId: "fixture-job" }],
  });
});
