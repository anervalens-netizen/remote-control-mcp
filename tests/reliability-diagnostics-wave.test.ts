import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { diagnosticsFor } from "../apps/mcp-server/src/tool-diagnostics.ts";
import { correlationHash } from "../packages/protocol/src/diagnostic-context.ts";
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
it("distinguishes agent delay, requested wait, output preparation, validation failure and caller-reported expiry", async () => {
  const app = Fastify();
  app.post("/v1/exec", async request => {
    const command = (request.body as any).command;
    if (command === "slow") await new Promise(resolve => setTimeout(resolve, 80));
    if (command === "invalid") return { code: "bad", stdout: "private output" };
    const stdout = command === "large" ? "x".repeat(1024 * 1024) : "synthetic";
    return { code: 0, signal: null, stdout, stderr: "", durationMs: 1, timedOut: false, stdoutBytes: stdout.length, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
  });
  const status = { id: "private-job", state: "completed", startedAt: "2026-01-01", command: "private-command", exitCode: 0 };
  app.post("/v1/jobs/status", async () => status);
  app.post("/v1/jobs/cancel", async () => status);
  app.post("/v1/jobs/follow", async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    const stream = { offset: 0, nextOffset: 0, totalBytes: 0, eof: true, data: "", bytes: 0, encoding: "utf8" };
    return { ...status, terminal: true, waitExpired: false, waitedMs: 100, outputComplete: true, cursor: { stdout: 0, stderr: 0 }, stdout: { ...stream, stream: "stdout" }, stderr: { ...stream, stream: "stderr" } };
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); close.push(() => app.close());
  const agent = new AgentClient([{ name: "fixture", url }]), server = new McpServer({ name: "diagnostic-fixture", version: "1" }); registerTools(server, agent);
  const client = new Client({ name: "diagnostic-fixture", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]); close.push(async () => { await client.close(); await server.close(); });
  await client.listTools();
  await client.callTool({ name: "exec", arguments: { device: "fixture", command: "slow" } });
  await client.callTool({ name: "job_wait", arguments: { device: "fixture", id: "private-job", waitMs: 100 } });
  const start = performance.now();
  const [large, read, cancel] = await Promise.all([
    client.callTool({ name: "exec", arguments: { device: "fixture", command: "large" } }),
    client.callTool({ name: "job_status", arguments: { device: "fixture", id: "private-job" } }),
    client.callTool({ name: "job_cancel", arguments: { device: "fixture", id: "private-job" } }),
  ]);
  expect(performance.now() - start).toBeLessThan(1500); expect(read.isError).not.toBe(true); expect(cancel.isError).not.toBe(true);
  const invalid = await client.callTool({ name: "exec", arguments: { device: "fixture", command: "invalid" } }); expect(invalid.isError).toBe(true);
  const report = await client.callTool({ name: "diagnostic_wait_report", arguments: { requestId: "synthetic-request", source: "orchestrator" } });
  expect(report.isError).not.toBe(true);
  const diagnostics = diagnosticsFor(agent).snapshot();
  const exec = diagnostics.traces.filter(t => t.tool === "exec");
  expect(exec[0]!.trace.stages.agentRequest!.ms).toBeGreaterThanOrEqual(70);
  expect(exec[0]!.trace.stages.executionWait).toBeUndefined();
  const wait = diagnostics.traces.find(t => t.tool === "job_wait")!.trace;
  expect(wait.stages.executionWait!.ms).toBe(100); expect(wait.correlation.job).toBe(correlationHash("private-job"));
  expect(exec[1]!.trace.totalBytes).toBe(Buffer.byteLength(JSON.stringify(large)));
  expect(exec[1]!.trace.stages.resultPreparation!.ms).toBeGreaterThan(0);
  expect(exec[2]!.trace.stages.finalValidation!.count).toBeGreaterThanOrEqual(1);
  expect(diagnostics.series.find(s => s.tool === "exec")).toMatchObject({ finalValidationFailures: 1 });
  expect(diagnostics).toMatchObject({ waitExpiryReports: 1, waitReports: [{ requestHash: correlationHash("synthetic-request"), source: "orchestrator" }] });
  expect(JSON.stringify(diagnostics)).not.toMatch(/private-job|private-command|private output/);
  expect(diagnostics.traces.every(t => t.trace.queueMs === null && t.trace.clientAcceptance === "unknown")).toBe(true);
}, 10000);
