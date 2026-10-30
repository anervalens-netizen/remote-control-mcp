import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { runCommand } from "../apps/agent/src/exec.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { OperationObserver, operationsFor } from "../apps/mcp-server/src/operation-observer.ts";

it("classifies repository failures through the agent and observer without replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-repo-audit-"));
  const agent = Fastify(); registerExtraRoutes(agent);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  const remote = new AgentClient([{ name: "fixture", url, userUrl: url }]);
  const server = new McpServer({ name: "fixture", version: "1" }); registerTools(server, remote);
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  try {
    for (const [target, status, code] of [[path.join(root, "missing"), 404, "ENOENT"], [root, 400, "REPO_NOT_FOUND"]] as const) {
      const result = await client.callTool({ name: "repo_snapshot", arguments: { device: "fixture", path: target } });
      expect(result.isError).toBe(true);
      const content = result.structuredContent as any;
      expect(content).toMatchObject({ status, agentCode: code, observationCoverage: { admitted: true, detailsTool: "open_remote_control_console" } });
      const record = await operationsFor(remote).inspect(content.operationTrace.traceId);
      expect(record).toMatchObject({ state: "returned", requestSucceeded: false, callerDisconnected: false, failure: { status, agentCode: code } });
      expect(record?.events.map(e => e.stage)).toEqual(["handler_started", "agent_dispatch", "agent_response", "handler_returned"]);
      const recovery = await client.callTool({ name: "result_recover", arguments: { id: content.resultRecovery.id } });
      expect(recovery.isError).not.toBe(true);
      expect((await operationsFor(remote).inspect(content.operationTrace.traceId))?.events).toEqual(record?.events);
    }
    const details = await client.callTool({ name: "open_remote_control_console", arguments: {} });
    expect(details.isError).not.toBe(true);
    expect((details.structuredContent as any).operations.coverage).toHaveProperty("dailySummary");
    await writeFile(path.join(root, "file"), "fixture");
    const invalid = await agent.inject({ method: "POST", url: "/v1/repo/snapshot", payload: { path: path.join(root, "file") } });
    expect(invalid.statusCode).toBe(400); expect(invalid.json().code).toBe("ENOTDIR");
  } finally { await client.close(); await server.close(); await agent.close(); await rm(root, { recursive: true, force: true }); }
});

it("retains coverage faults in compact results and full details in the dashboard", async () => {
  const observer = new OperationObserver(undefined, 1);
  const id = (await observer.begin("exec", undefined))!;
  await observer.event(id, { stage: "agent_dispatch" });
  await observer.finish(id, undefined, false, false);
  expect(await observer.begin("exec", undefined)).toBeUndefined();
  const compact = observer.compactCoverage(id), full = (await observer.snapshot()).coverage;
  expect(compact).toMatchObject({ partial: true, faults: ["journal_capacity"], detailsTool: "open_remote_control_console", observationPersistence: "confirmed" });
  expect(compact).not.toHaveProperty("dailySummary");
  expect(full).toHaveProperty("dailySummary");
  expect(full.counters.admissionRefused).toBe(1);
  expect(await observer.inspect(id)).toMatchObject({ state: "unknown" });
});

it.skipIf(process.platform !== "win32")("captures Unicode PowerShell output and preserves exit status", async () => {
  const result = await runCommand({ command: "[Console]::Out.WriteLine('ă😀'); [Console]::Error.WriteLine('ț😀'); exit 7" });
  expect(result.stdout).toContain("ă😀"); expect(result.stderr).toContain("ț😀"); expect(result.code).toBe(7);
  const piped = await runCommand({ command: "'ă😀' | & $env:RCMCP_TEST_NODE -e 'process.stdin.pipe(process.stdout)'", env: { RCMCP_TEST_NODE: process.execPath } });
  expect(piped.stdout).toContain("ă😀"); expect(piped.code).toBe(0);
});


it.skipIf(process.platform !== "win32")("preserves PowerShell grammar and final failure status", async () => {
  const param = await runCommand({ command: 'param([string]$x="OK"); $x' });
  expect(param.stdout.trim()).toBe("OK"); expect(param.stderr).not.toMatch(/param.*not recognized/i); expect(param.code).toBe(0);
  const using = await runCommand({ command: 'using namespace System.Text\n[StringBuilder]::new("OK").ToString()' });
  expect(using.stdout.trim()).toBe("OK"); expect(using.code).toBe(0);
  const comment = await runCommand({ command: 'Write-Output OK # trailing comment' });
  expect(comment.stdout.trim()).toBe("OK"); expect(comment.code).toBe(0);
  const native = await runCommand({ command: 'cmd.exe /c exit 7' }); expect(native.code).toBe(1);
  const error = await runCommand({ command: 'Write-Error failure' }); expect(error.code).toBe(1);
  const recovered = await runCommand({ command: 'cmd.exe /c exit 7; Write-Output OK' }); expect(recovered.code).toBe(0);
});
