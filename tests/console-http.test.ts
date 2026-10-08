import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { CONSOLE_URI } from "../apps/mcp-server/src/console-resource.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
it("serves the same UI resource and opener through modern, initial legacy, and reconnected legacy sessions", async () => {
  const http = createMcpHttpServer(new AgentClient([]), { token: "fixture-token" });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const url = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`);
  const headers = { Authorization: "Bearer fixture-token" };
  const scopes: string[] = [];
  let html: string | undefined;
  for (const era of ["modern", "legacy", "legacy"] as const) {
    const client = era === "modern" ? new ModernClient({ name: "fixture", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } }) : new Client({ name: "fixture", version: "1" });
    if (client instanceof ModernClient) await client.connect(new ModernTransport(url, { requestInit: { headers } }));
    else await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    closers.push(() => client.close());
    const tools = (await client.listTools()).tools;
    const opener = tools.find(tool => tool.name === "open_remote_control_console");
    expect(opener?._meta).toMatchObject({ ui: { resourceUri: CONSOLE_URI }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } });
    expect(tools.find(tool => tool.name === "operation_inspect")?._meta).toMatchObject({ ui: { visibility: ["app"] } });
    expect((await client.listResources()).resources.some(r => r.uri === CONSOLE_URI)).toBe(true);
    const resource = await client.readResource({ uri: CONSOLE_URI });
    expect(resource.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", _meta: { "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["fullscreen"] } } });
    const content = resource.contents[0] as { text: string };
    expect(content.text).toContain("Fleet & operations");
    if (html) expect(content.text).toBe(html); else html = content.text;
    const opened = await client.callTool({ name: "open_remote_control_console", arguments: {} });
    expect(opened.isError).not.toBe(true);
    const data = opened.structuredContent as { diagnosticScopeId: string };
    expect(data.diagnosticScopeId).toMatch(/^[a-f0-9-]{36}$/);
    expect(opened.structuredContent).not.toHaveProperty("resultRecovery");
    scopes.push(data.diagnosticScopeId);
    await client.close();
  }
  expect(new Set(scopes).size).toBe(3);
  const denied = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: CONSOLE_URI } }) });
  expect(denied.status).toBe(401);
});
