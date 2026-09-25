import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient, AgentEndpointContext } from "../apps/mcp-server/src/agent-client.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function harness(fake: AgentClient) {
  const server = new McpServer({ name: "test", version: "1" });
  registerHighLevelTools(server, fake);
  const client = new Client({ name: "client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("high-level execution identity", () => {
  it("uses the selected root identity for both deploy snapshot and job", async () => {
    const seen: Array<[string, AgentEndpointContext]> = [];
    const fake = {
      configuredContexts: () => ({ system: true, user: false, desktop: false }),
      repoSnapshot: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(["snapshot", context]); return { head: "abc" }; },
      jobStart: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(["job", context]); return { id: "job", state: "running" }; },
    } as unknown as AgentClient;
    const client = await harness(fake);
    const result = await client.callTool({ name: "deploy_run", arguments: { device: "pc", command: "deploy", repoPath: "/root/repo", identity: "root" } });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual([["snapshot", "system"], ["job", "system"]]);
  });

  it("routes Git network tools through owner identity by default", async () => {
    const seen: Array<[string, AgentEndpointContext]> = [];
    const fake = {
      configuredContexts: () => ({ system: true, user: true, desktop: false }),
      repoFetch: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(["fetch", context]); return { ok: true, operation: "fetch", remote: "origin", nonInteractive: true, timeoutMs: 60000, durationMs: 1, summary: "" }; },
      repoPull: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(["pull", context]); return { ok: true, operation: "pull", remote: null, nonInteractive: true, timeoutMs: 60000, durationMs: 1, summary: "", beforeHead: "abc", afterHead: "abc", headChanged: false }; },
      repoPush: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(["push", context]); return { ok: true, operation: "push", remote: "origin", nonInteractive: true, timeoutMs: 60000, durationMs: 1, summary: "" }; },
    } as unknown as AgentClient;
    const client = await harness(fake);
    for (const name of ["repo_fetch", "repo_pull", "repo_push"]) {
      const result = await client.callTool({ name, arguments: { device: "pc", path: "/repo" } });
      expect(result.isError).not.toBe(true);
    }
    expect(seen).toEqual([["fetch", "user"], ["pull", "user"], ["push", "user"]]);
  });

  it("preserves explicit root routing for Git network tools", async () => {
    const seen: AgentEndpointContext[] = [];
    const fake = {
      configuredContexts: () => ({ system: true, user: true, desktop: false }),
      repoFetch: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(context); return { ok: true, operation: "fetch", remote: "origin", nonInteractive: true, timeoutMs: 60000, durationMs: 1, summary: "" }; },
    } as unknown as AgentClient;
    const client = await harness(fake);
    const result = await client.callTool({
      name: "repo_fetch",
      arguments: { device: "pc", path: "/repo", identity: "root" },
    });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual(["system"]);
  });

  it("fails Git network tools before falling back to SYSTEM when owner is unavailable", async () => {
    let called = false;
    const fake = {
      configuredContexts: () => ({ system: true, user: false, desktop: false }),
      repoFetch: async () => { called = true; return { ok: true }; },
    } as unknown as AgentClient;
    const client = await harness(fake);
    const result = await client.callTool({ name: "repo_fetch", arguments: { device: "pc", path: "/repo" } });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("keeps project_run owner-aware by default", async () => {
    const seen: AgentEndpointContext[] = [];
    const fake = {
      configuredContexts: () => ({ system: true, user: true, desktop: false }),
      projectRun: async (_device: string, _input: unknown, context: AgentEndpointContext) => { seen.push(context); return { mode: "job", result: { id: "job", state: "running" } }; },
    } as unknown as AgentClient;
    const client = await harness(fake);
    const result = await client.callTool({ name: "project_run", arguments: { device: "pc", path: "/repo", action: "check" } });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual(["user"]);
  });
});
