import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient, AgentEndpointContext } from "../apps/mcp-server/src/agent-client.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { registerRepoTools } from "../apps/mcp-server/src/repo-tools.ts";
import { registerSecretTools } from "../apps/mcp-server/src/secret-tools.ts";
import { SecretStore } from "../apps/mcp-server/src/secret-store.ts";
import { registerTools } from "../apps/mcp-server/src/tools.ts";

const closers: Array<() => Promise<void>> = [];
const roots: string[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const fake = {
    devices: [{ name: "pc", url: "http://127.0.0.1:1" }],
    configuredContexts: () => ({ system: true, user: true, desktop: false }),
    repoGitPath: async () => ({
      root: "/repo", gitDir: "/repo/.git", commonGitDir: "/repo/.git", gitPath: "HEAD", resolved: "/repo/.git/HEAD",
    }),
    repoFetch: async (_device: string, _input: unknown, _context: AgentEndpointContext) => ({
      ok: true, operation: "fetch", remote: "origin", nonInteractive: true, timeoutMs: 60000, durationMs: 3, summary: "",
    }),
  } as unknown as AgentClient;

  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-structured-"));
  roots.push(root);
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, fake);
  registerRepoTools(server, fake);
  registerHighLevelTools(server, fake);
  registerSecretTools(server, fake, new SecretStore(root));

  const client = new Client({ name: "client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("structured MCP result contracts", () => {
  it("advertises schemas and truthful annotations for compact stable tools", async () => {
    const client = await harness();
    const listed = await client.listTools();
    const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

    expect(tools.get("devices_list")?.outputSchema).toBeTruthy();
    expect(tools.get("devices_list")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.get("repo_git_path")?.outputSchema).toBeTruthy();
    expect(tools.get("repo_git_path")?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get("repo_fetch")?.outputSchema).toBeTruthy();
    expect(tools.get("repo_fetch")?.annotations).toMatchObject({
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true,
    });
    expect(tools.get("repo_pull")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false });
    expect(tools.get("repo_push")?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
    expect(tools.get("secret_status")?.outputSchema).toBeTruthy();
    expect(tools.get("secret_delete")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });

  it("returns structuredContent while preserving backwards-compatible text JSON", async () => {
    const client = await harness();

    const devices = await client.callTool({ name: "devices_list", arguments: {} });
    expect(devices.isError).not.toBe(true);
    expect(devices.structuredContent).toEqual({
      devices: [{ name: "pc", url: "http://127.0.0.1:1", contexts: { system: true, user: true, desktop: false } }],
    });
    const deviceContent = devices.content as Array<{ type: string; text?: string }>;
    expect(JSON.parse(deviceContent[0]?.text ?? "null")).toEqual([
      { name: "pc", url: "http://127.0.0.1:1", contexts: { system: true, user: true, desktop: false } },
    ]);

    const gitPath = await client.callTool({
      name: "repo_git_path", arguments: { device: "pc", path: "/repo", gitPath: "HEAD" },
    });
    expect(gitPath.isError).not.toBe(true);
    expect(gitPath.structuredContent).toMatchObject({ root: "/repo", gitPath: "HEAD", resolved: "/repo/.git/HEAD" });

    const fetch = await client.callTool({ name: "repo_fetch", arguments: { device: "pc", path: "/repo" } });
    expect(fetch.isError).not.toBe(true);
    expect(fetch.structuredContent).toMatchObject({
      identity: "owner", context: "user",
      result: { ok: true, operation: "fetch", remote: "origin", nonInteractive: true },
    });

    const secret = await client.callTool({ name: "secret_status", arguments: { alias: "missing" } });
    expect(secret.isError).not.toBe(true);
    expect(secret.structuredContent).toEqual({ alias: "missing", present: false });
  });
});
