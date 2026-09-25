import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/tools.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function harness() {
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  // Real SDK -> AgentClient -> HTTP. These endpoints label routing, not OS identities;
  // native UID/SID checks are performed by the release canary on the actual agents.
  const http = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data || "{}") as Record<string, unknown>;
    calls.push({ route: req.url!, body });
    res.setHeader("content-type", "application/json");
    const value = req.url!.endsWith("/v1/fs/read")
      ? { path: body.path, totalBytes: 7, offset: 0, nextOffset: 7, bytesRead: 7, eof: true, encoding: "utf8", data: "fixture" }
      : { code: 0, signal: null, stdout: "fixture", stderr: "", durationMs: 1, timedOut: false, stdoutBytes: 7, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
    res.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const agent = new AgentClient([
    { name: "pc", url: `${base}/system`, userUrl: `${base}/user`, desktopUrl: `${base}/desktop` },
    { name: "no-owner", url: `${base}/system` },
  ], "synthetic-fixture-token");
  const server = new McpServer({ name: "m15-identity", version: "1" });
  registerTools(server, agent);
  registerHighLevelTools(server, agent);
  const client = new Client({ name: "m15-identity-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return { client, calls };
}

function textJson(result: any) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe("M15 W1 identity and structured batch contract", () => {
  it("routes a mixed batch by per-item identity and preserves literal env", async () => {
    const { client, calls } = await harness();
    const result = await client.callTool({ name: "batch_exec", arguments: { items: [
      { device: "pc", command: "echo fixture", identity: "owner", elevation: "never", env: { identity: "not-a-routing-option", VALUE: "ș ț 😀" } },
      { device: "pc", command: "echo fixture", identity: "root" },
      { device: "pc", command: "echo fixture", identity: "interactive" },
    ], concurrency: 2 } });
    expect(result.isError).not.toBe(true);
    expect(calls.map(c => c.route).sort()).toEqual(["/desktop/v1/exec", "/system/v1/exec", "/user/v1/exec"]);
    expect(calls.find(c => c.route === "/user/v1/exec")?.body.env).toEqual({ identity: "not-a-routing-option", VALUE: "ș ț 😀" });
    expect(textJson(result).map((x: { result: { stdout: string } }) => x.result.stdout)).toEqual(["fixture", "fixture", "fixture"]);
    expect(result.structuredContent).toMatchObject({ partial: false, errors: [], items: [
      { index: 0, identity: "owner", context: "user" },
      { index: 1, identity: "root", context: "system" },
      { index: 2, identity: "interactive", context: "desktop" },
    ] });
  });

  it("rejects unknown nested routing fields before executing any batch item", async () => {
    const { client, calls } = await harness();
    const result = await client.callTool({ name: "batch_exec", arguments: { items: [
      { device: "pc", command: "echo first" },
      { device: "pc", command: "echo second", identitty: "owner" },
    ] } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("uses canonical identity when legacy context is stale or contradictory", async () => {
    const { client, calls } = await harness();
    const result = await client.callTool({ name: "batch_exec", arguments: { items: [
      { device: "pc", command: "echo second", context: "system", identity: "owner" },
    ] } });
    expect(result.isError).not.toBe(true);
    expect(calls.map(c => c.route)).toEqual(["/user/v1/exec"]);
    expect(result.structuredContent).toMatchObject({ items: [
      { index: 0, identity: "owner", context: "user" },
    ] });
  });

  it("preflights endpoint availability for the complete batch", async () => {
    const { client, calls } = await harness();
    const result = await client.callTool({ name: "batch_exec", arguments: { items: [
      { device: "pc", command: "echo first", identity: "owner" },
      { device: "no-owner", command: "echo second", identity: "owner" },
    ] } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("keeps the user context alias and adds structured read results", async () => {
    const { client, calls } = await harness();
    const result = await client.callTool({ name: "batch_read", arguments: { items: [
      { device: "pc", path: "/fixture", context: "user" },
      { device: "pc", path: "/fixture", identity: "owner", elevation: "never" },
    ] } });
    expect(result.isError).not.toBe(true);
    expect(calls.map(c => c.route)).toEqual(["/user/v1/fs/read", "/user/v1/fs/read"]);
    expect(Array.isArray(textJson(result))).toBe(true);
    expect(result.structuredContent).toMatchObject({ partial: false, errors: [], items: [
      { index: 0, context: "user", result: { data: "fixture" } },
      { index: 1, context: "user", result: { data: "fixture" } },
    ] });
  });

  it("rejects misspelled core options and reports the selected single-exec identity", async () => {
    const { client, calls } = await harness();
    const invalid = await client.callTool({ name: "exec", arguments: { device: "pc", command: "echo fixture", identitty: "owner" } });
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(0);
    const valid = await client.callTool({ name: "exec", arguments: { device: "pc", command: "echo fixture", identity: "owner" } });
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toMatchObject({ code: 0, identity: "owner", context: "user" });
    expect(textJson(valid).stdout).toBe("fixture");
  });

  it("publishes identity incompatibilities and strict nested input in tools/list", async () => {
    const { client } = await harness();
    const tools = (await client.listTools()).tools;
    for (const name of ["exec", "repo_fetch"]) {
      const input = tools.find(t => t.name === name)!.inputSchema as any;
      expect(input.additionalProperties).toBe(false);
      expect(input.properties.identity).toBeTruthy();
      expect(input.properties.context).toBeTruthy();
      expect(input.properties.elevation).toBeTruthy();
      expect(input.properties.identity.description).toContain("owner->user");
    }
    const batch = tools.find(t => t.name === "batch_exec")!;
    const item = (batch.inputSchema.properties as Record<string, any>).items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.identity).toBeTruthy();
    expect(item.properties.elevation).toBeTruthy();
    expect(batch.inputSchema.additionalProperties).toBe(false);
    expect(batch.outputSchema).toBeTruthy();
  });
});
