import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";

const recovery = {
  jobId: "rc25-job-id", pid: 12345, processIdentity: "opaque-process-identity",
  executionMarker: "RCMCP_JOB_ID=rc25-job-id", marker: "RCMCP_JOB_ID=rc25-job-id",
  metadataPath: "/fixture/job.json", stdoutPath: "/fixture/job.stdout.log",
  stderrPath: "/fixture/job.stderr.log", exitPath: "/fixture/job.exit",
  processStatus: "uncertain" as const, terminationVerified: false,
};
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.doUnmock("../apps/agent/src/jobs.ts"); vi.resetModules();
});
async function agentFixture() {
  vi.doMock("../apps/agent/src/jobs.ts", async (original) => {
    const jobs = await original<typeof import("../apps/agent/src/jobs.ts")>();
    return { ...jobs, jobStart: vi.fn(async () => { throw new jobs.JobRecoveryError("Recovery required", {
      ...recovery, terminationError: "x".repeat(100_000), cleanupErrors: ["y".repeat(100_000)],
    }); }) };
  });
  const app = Fastify(); (await import("../apps/agent/src/extra-routes.ts")).registerExtraRoutes(app);
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  return { app, client: new AgentClient([{ name: "fixture", url, userUrl: url }]) };
}
it.each([
  ["/v1/jobs/start", { command: "unused" }],
  ["/v1/project/run", { path: process.cwd(), command: "unused", mode: "job" }],
  ["/v1/deploy/run", { apply: "unused", prepare: "unused" }],
  ["/v1/power", { action: "lock" }],
  ["/v1/power/request", { action: "lock" }],
])("retains bounded structured recovery in HTTP %s", async (url, payload) => {
  const { app } = await agentFixture();
  const response = await app.inject({ method: "POST", url: url as string, payload });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toMatchObject({ error: "job_recovery_required", ...recovery, truncatedFields: expect.arrayContaining(["terminationError", "cleanupErrors"]) });
  expect(Buffer.byteLength(response.body)).toBeLessThan(64 * 1024);
});
it("retains typed recovery in AgentClient without parsing nested text", async () => {
  const { client } = await agentFixture();
  await expect(client.jobStart("fixture", { command: "unused" })).rejects.toMatchObject({
    name: "AgentRequestError", kind: "http", status: 500, recovery: { error: "job_recovery_required", ...recovery },
  });
});
it.each([false, true])("preserves recovery through the real SDK (default contracts=%s), including durable wrappers and per-device errors", async (contracts) => {
  const { client } = await agentFixture();
  const server = new McpServer({ name: "rc25", version: "1" });
  if (contracts) installDefaultToolOutputContracts(server);
  registerHighLevelTools(server, client); registerJobTools(server, client);
  if (contracts) {
    // A thrown error from any other registered tool must use the same formatter.
    server.registerTool("host_power", { inputSchema: {} }, async () => {
      await client.requestRoute("fixture", "/v1/power", { action: "lock" });
      throw new Error("unreachable");
    });
  }
  const sdk = new Client({ name: "rc25-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), sdk.connect(right)]);
  closers.push(async () => { await sdk.close(); await server.close(); });
  const calls = [
    { name: "job_start", arguments: { device: "fixture", command: "unused" } },
    { name: "project_run", arguments: { device: "fixture", path: process.cwd(), command: "unused", mode: "job" } },
    { name: "deploy_run", arguments: { device: "fixture", apply: "unused" } },
    { name: "deploy_run", arguments: { device: "fixture", command: "unused" } },
    ...(contracts ? [{ name: "host_power", arguments: {} }] : []),
  ];
  for (const call of calls) {
    const result = await sdk.callTool(call);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ recovery: { ...recovery, truncatedFields: expect.arrayContaining(["terminationError"]) } });
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThan(64 * 1024);
  }
  const batch = await sdk.callTool({ name: "job_start_many", arguments: { devices: ["fixture"], command: "unused" } });
  expect(batch.structuredContent).toMatchObject({ items: [{ ok: false, device: "fixture", recovery }] });
});
it("does not publish arbitrary HTTP body fields as structured recovery or generic error text", async () => {
  const app = Fastify(); app.post("/v1/jobs/start", async (_, reply) => reply.code(500).send({ error: "oops", credential: "fixture-secret" }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const client = new AgentClient([{ name: "fixture", url }]);
  let caught: unknown; try { await client.jobStart("fixture", {}); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ kind: "http", status: 500 });
  expect(String(caught)).not.toContain("fixture-secret");
  expect(caught).not.toHaveProperty("recovery", expect.anything());
});

it("parses old recovery bodies above 64 KiB before bounding diagnostics, with explicit truncation", async () => {
  const app = Fastify();
  app.post("/v1/jobs/start", async (_, reply) => reply.code(500).send({
    error: "job_recovery_required", message: "x".repeat(100_000), ...recovery,
    arbitrarySecret: "never-copy-this", terminationError: "\u0000".repeat(100_000),
  }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const client = new AgentClient([{ name: "fixture", url }]);
  let caught: any; try { await client.jobStart("fixture", {}); } catch (error) { caught = error; }
  expect(caught.recovery).toMatchObject({ ...recovery, truncatedFields: expect.arrayContaining(["message", "terminationError"]) });
  expect(JSON.stringify(caught.recovery)).not.toContain("never-copy-this");
  expect(Buffer.byteLength(JSON.stringify(caught.recovery))).toBeLessThan(64 * 1024);
});
it("bounds oversized non-recovery HTTP bodies and reports body truncation explicitly", async () => {
  const app = Fastify(); app.post("/v1/jobs/start", async (_, reply) => reply.code(500).send("x".repeat(2 * 1024 * 1024)));
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const client = new AgentClient([{ name: "fixture", url }]);
  await expect(client.jobStart("fixture", {})).rejects.toMatchObject({ kind: "http", status: 500, responseBodyTruncated: true });
});
