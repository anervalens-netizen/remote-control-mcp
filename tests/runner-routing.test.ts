import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { jobRemove, jobCancel } from "../apps/agent/src/jobs.ts";

it("carries project/deploy/follow workflows through the real MCP SDK and HTTP agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-run-routing-")), ids: string[] = [];
  const agent = Fastify(); registerExtraRoutes(agent);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  const server = new McpServer({ name: "runner-test", version: "1" });
  const remote = new AgentClient([{ name: "pc", url, userUrl: url }]);
  registerHighLevelTools(server, remote); registerJobTools(server, remote);
  const client = new Client({ name: "test", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { device: "pc", context: "user", ...args } });
    return { result, body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
  };
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const bad = await call("project_run", { path: root, command: "exit 17", mode: "exec" });
    expect(bad.result.isError).toBe(true); expect(bad.body).toMatchObject({ ok: false, result: { code: 17 } });
    const preview = await call("project_run", { path: root, stack: "rust", dryRun: true });
    expect(preview.body).toMatchObject({ dryRun: true, plan: { argv: ["cargo", "check"] } });
    const deploy = await call("deploy_run", { cwd: root, apply: "exit 17", recover: "exit 0" });
    expect(deploy.result.isError).not.toBe(true); ids.push(deploy.body.job.id);
    const done = await call("job_wait", { id: ids[0], waitMs: 15000, maxBytes: 8 });
    expect(done.body).toMatchObject({ terminal: true, exitCode: 17, progress: { state: "recovered" } });
    let cursor = done.body.cursor, output = done.body.stderr.data;
    for (let i = 0; i < 30; i++) {
      const next = await call("job_output_since", { id: ids[0], cursor, maxBytes: 8 });
      cursor = next.body.cursor; output += next.body.stderr.data;
      if (next.body.outputComplete) break;
    }
    expect(output).toContain("[deploy] apply failed (exit 17)");
    expect(output).toContain("[deploy] recover succeeded (exit 0)");
    const invalid = await agent.inject({ method: "POST", url: "/v1/jobs/follow", payload: { id: ids[0], cursor: { stdout: -1, stderr: 0 } } });
    expect(invalid.statusCode).toBe(400);
  } finally {
    for (const id of ids) { await jobCancel(id); await jobRemove(id); }
    await client.close(); await server.close(); agent.server.closeAllConnections(); await agent.close();
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
