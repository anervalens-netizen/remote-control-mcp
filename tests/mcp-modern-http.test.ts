import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import Fastify from "fastify";
import { registerDesktopRoutes } from "../apps/agent/src/desktop-routes.ts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function harness(agentClient = new AgentClient([])) {
  const http = createMcpHttpServer(agentClient, { token: "synthetic-token" });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;
  async function modern(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return fetch(url, { method: "POST", headers: {
      Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}), ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: "same-request-id", method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "synthetic-client", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {}, ...(params._meta as object ?? {}),
    } } }) });
  }
  return { url, modern };
}
describe("modern MCP alongside legacy sessions", () => {
  it("discovers and calls tools without initialize or a session", async () => {
    const { modern } = await harness();
    const discover = await modern("server/discover");
    expect(discover.status).toBe(200);
    expect(discover.headers.get("mcp-session-id")).toBeNull();
    const discovery = await discover.json();
    expect(discovery.id).toBe("same-request-id");
    expect(discovery.result.supportedVersions).toContain("2026-07-28");
    expect(discovery.result.resultType).toBe("complete");
    const call = await modern("tools/call", { name: "devices_list", arguments: {} });
    expect(call.status).toBe(200);
    const result = await call.json();
    expect(result.result.resultType).toBe("complete");
    expect(result.result.structuredContent.devices).toEqual([]);
    expect(result.result.isError).not.toBe(true);
  });
  it("preserves the advertised legacy tool contracts", async () => {
    const { url, modern } = await harness();
    const current = await (await modern("tools/list")).json();
    const old = await fetch(url, { method: "POST", headers: {
      Authorization: "Bearer synthetic-token", "Content-Type": "application/json", Accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const legacy = JSON.parse((await old.text()).split("\n").find(line => line.startsWith("data:"))!.slice(5));
    const contracts = (rows: any[]) => rows.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema })).sort((a,b) => a.name.localeCompare(b.name));
    // The modern SDK advertises JSON Schema 2020-12; v1 uses draft-07.
    // All actual constraints must remain equal.
    const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === "$schema" ? undefined : item));
    expect(normalize(contracts(current.result.tools))).toEqual(normalize(contracts(legacy.result.tools)));
  });
  it("enforces authentication and origin before modern dispatch", async () => {
    const { modern } = await harness();
    expect((await modern("server/discover", {}, { Authorization: "" })).status).toBe(401);
    expect((await modern("server/discover", {}, { Origin: "https://untrusted.example" })).status).toBe(403);
  });
  it("rejects inconsistent protocol metadata instead of silently falling back", async () => {
    const { modern } = await harness();
    const response = await modern("server/discover", {}, { "MCP-Protocol-Version": "2025-11-25" });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });
  it("uses the official modern client and retains reserved results across requests", async () => {
    const { url } = await harness();
    const client = new ModernClient({ name: "synthetic-sdk", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer synthetic-token" } } }));
    closers.unshift(async () => { await client.close(); });
    expect((await client.listTools()).tools.some(t => t.name === "device_info")).toBe(true);
    const reserved = await client.callTool({ name: "result_recovery_prepare", arguments: {} });
    const id = (reserved.structuredContent as { id: string }).id as string;
    const reply = await client.callTool({ name: "device_info", arguments: { device: "missing-device" }, _meta: { resultRecoveryId: id } });
    expect(reply.isError).toBe(true);
    expect(((reply.structuredContent as { resultRecovery: { id: string } }).resultRecovery as { id: string }).id).toBe(id);
    const recovered = await client.callTool({ name: "result_recover", arguments: { id } });
    expect(recovered.isError).not.toBe(true);
    expect((recovered.structuredContent as { state: string }).state).toBe("complete");
  });
  it("propagates modern cancellation to the agent and releases the lane for the next request", async () => {
    const agent = Fastify();
    registerDesktopRoutes(agent);
    const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => { agent.server.closeAllConnections(); await agent.close(); });
    const { url } = await harness(new AgentClient([{ name: "pc", url: agentUrl, desktopUrl: agentUrl }]));
    const client = new ModernClient({ name: "synthetic-cancel", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new ModernTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer synthetic-token" } } }));
    closers.unshift(async () => { await client.close(); });
    await client.listTools();
    const controller = new AbortController();
    const pending = client.callTool({ name: "desktop_batch", arguments: { device: "pc", actions: [{ kind: "wait", ms: 10000 }] } }, { signal: controller.signal });
    void pending.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await expect(pending).rejects.toThrow();
    const next = await client.callTool({ name: "desktop_batch", arguments: { device: "pc", actions: [{ kind: "wait", ms: 1 }] } }, { timeout: 1500 });
    expect(next.isError).not.toBe(true);
  }, 5000);

});
