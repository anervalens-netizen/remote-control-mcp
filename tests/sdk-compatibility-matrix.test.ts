import { afterEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { SdkCompatibilityDiagnostics, sdkVersion, catalogRevision } from "../apps/mcp-server/src/sdk-compatibility.ts";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";
import { fsRead } from "../apps/agent/src/filesystem.ts";
import { writeFileSync } from "node:fs";
import path from "node:path";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const receipt = { code: 0, signal: null, stdout: "synthetic", stderr: "", durationMs: 1, timedOut: false, stdoutBytes: 9, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
async function harness(sessionMode: "stateful" | "stateless", enableJsonResponse: boolean) {
  const backend = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  let effects = 0;
  vi.spyOn(backend, "exec").mockImplementation(async (_name, input) => { effects++; return input.command === "invalid" ? { ...receipt, code: "invalid" } as any : receipt; });
  const http = createMcpHttpServer(backend, { token: "fixture-token", sessionMode, enableJsonResponse });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); });
  async function connect() {
    const client = new Client({ name: "matrix", version: "1" });
    const responses: Array<{ method: string; contentType: string | null }> = [];
    const cancelled = Promise.withResolvers<void>();
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer fixture-token" } },
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (typeof init?.body === "string") {
          const message = JSON.parse(init.body);
          responses.push({ method: message.method, contentType: response.headers.get("content-type") });
          if (message.method === "notifications/cancelled") cancelled.resolve();
        }
        return response;
      },
    });
    await client.connect(transport);
    closers.push(async () => { if (transport.sessionId) await transport.terminateSession(); await client.close(); });
    return { client, transport, responses, cancelled: cancelled.promise };
  }
  return { base, connect, backend, effects: () => effects };
}
it.each([ ["stateful", false], ["stateful", true], ["stateless", false], ["stateless", true] ] as const)("SDK production matrix %s JSON=%s: negotiation, catalog, validation and recovery", async (mode, json) => {
  const h = await harness(mode, json), { client, transport, responses } = await h.connect();
  expect(Boolean(transport.sessionId)).toBe(mode === "stateful");
  const catalog = await client.listTools();
  expect(catalog.tools.find(t => t.name === "resource_coordination")?.inputSchema.properties).toHaveProperty("ownerOverride");
  expect(catalog.tools.find(t => t.name === "project_run")?.inputSchema.properties).toHaveProperty("coordination");
  const reserved: any = await client.callTool({ name: "result_recovery_prepare", arguments: {} });
  const id = reserved.structuredContent.id;
  const result: any = await client.callTool({ name: "exec", arguments: { device: "fixture", command: "invalid" }, _meta: { resultRecoveryId: id } });
  expect(result.isError).toBe(true); expect(result.structuredContent.code).toBe("result_validation_failed");
  const recovered: any = await client.callTool({ name: "result_recover", arguments: { id } });
  expect(recovered.isError).not.toBe(true);
  expect(JSON.parse(Buffer.from(recovered.structuredContent.data, "base64").toString()).structuredContent.code).toBe("invalid");
  expect(h.effects()).toBe(1);
  const health: any = await fetch(h.base + "/health/details", { headers: { Authorization: "Bearer fixture-token" } }).then(r => r.json());
  expect(health.compatibility).toMatchObject({ sdkVersion, catalogRevision, retention: 32 });
  expect(health.compatibility.observations).toContainEqual(expect.objectContaining({ mode, protocolVersion: transport.protocolVersion, responseMode: json ? "json" : "sse", source: "sdk_initialize_response" }));
  expect(transport.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const initialize = responses.find(r => r.method === "initialize")!;
  expect(initialize.contentType).toContain(json ? "application/json" : "text/event-stream");
  console.info(JSON.stringify({ sdkVersion, mode, negotiatedProtocolVersion: transport.protocolVersion, initializeContentType: initialize.contentType }));
  const next = await h.connect();
  expect(await next.client.listTools()).toEqual(catalog);
  expect(health.sessions.toolRegistryBuilds).toBe(1);
});
it.each([false, true])("stateless SDK cancellation JSON=%s cannot target a different request instance", async json => {
  const h = await harness("stateless", json), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  vi.spyOn(h.backend, "exec").mockImplementation(async (_device, _request, _context, options) => {
    signal = options!.signal!; entered.resolve(); await finish.promise; return receipt;
  });
  const connection = await h.connect(), abort = new AbortController();
  try {
    const request = connection.client.callTool({ name: "exec", arguments: { device: "fixture", command: "wait" } }, undefined, { signal: abort.signal });
    const rejection = expect(request).rejects.toThrow();
    await entered.promise; abort.abort(); await rejection; await connection.cancelled;
    expect(signal?.aborted).toBe(false);
    expect((await connection.client.listTools()).tools.length).toBeGreaterThan(0);
  } finally { finish.resolve(); }
});
it.each([false, true])("stateful SDK cancellation reaches the handler with JSON=%s", async json => {
  const h = await harness("stateful", json), entered = Promise.withResolvers<void>(), cancelled = Promise.withResolvers<void>();
  vi.spyOn(h.backend, "exec").mockImplementation(async (_device, _request, _context, options) => {
    entered.resolve();
    return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => { cancelled.resolve(); reject(new Error("cancelled")); }, { once: true }));
  });
  const { client } = await h.connect(); await client.listTools();
  const abort = new AbortController();
  const request = client.callTool({ name: "exec", arguments: { device: "fixture", command: "wait" } }, undefined, { signal: abort.signal });
  const rejection = expect(request).rejects.toThrow(); await entered.promise; abort.abort(); await rejection; await cancelled.promise;
  expect((await client.listTools()).tools.length).toBeGreaterThan(0);
});
it("current agents advertise UTF-8 and old agents reject gated effects while additive reads fall back", async () => {
  const agent = Fastify(); let current = false, effects = 0, reads = 0, rawEffects = 0;
  agent.get("/v1/info", async () => ({ runtime: current ? runtimeStatus() : { capabilities: [] } }));
  agent.post("/v1/fs/read", async request => { reads++; return fsRead(request.body as any); });
  agent.post("/v1/project/run", async () => { effects++; return {}; });
  agent.post("/v1/exec", async () => { rawEffects++; return receipt; });
  agent.get("/v1/processes", async () => [{ pid: 123, name: "fixture" }]);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => agent.close());
  const client = new AgentClient([{ name: "fixture", url, userUrl: url }]);
  const file = path.join(process.env.RCMCP_STATE_DIR!, "utf8.txt"); writeFileSync(file, "é😀z");
  await expect(client.fsRead("fixture", { path: file, length: 1 })).rejects.toThrow("agent_upgrade_required");
  expect(reads).toBe(0);
  const bytes: any = await client.fsRead("fixture", { path: file, encoding: "base64", length: 7 });
  expect(Buffer.from(bytes.data, "base64").toString()).toBe("é😀z");
  await expect(client.projectRun("fixture", { path: ".", coordination: { resourceId: "a".repeat(64), operationId: "00000000-0000-4000-8000-000000000001", generation: 1, baseVersion: "b".repeat(64) } })).rejects.toThrow("agent_upgrade_required");
  expect(effects).toBe(0);
  for (const [route, input] of [
    ["/v1/repo/checkpoint", { path: "." }], ["/v1/repo/apply-patch", { path: ".", patch: "synthetic" }],
    ["/v1/repo/fetch", { path: "." }], ["/v1/repo/pull", { path: "." }], ["/v1/repo/push", { path: "." }],
    ["/v1/service", { name: "synthetic", action: "restart" }], ["/v1/deploy/run", { cwd: ".", command: "synthetic" }],
  ] as const) await expect(client.requestRoute("fixture", route, input)).rejects.toThrow("agent_upgrade_required");
  // Raw owner execution never enters the high-level capability lane, including
  // unknown input extensions that legacy agents are free to ignore.
  expect(await client.requestRoute("fixture", "/v1/exec", { command: "synthetic", coordination: {} })).toEqual(receipt);
  expect(rawEffects).toBe(1);
  expect(await client.processFind("fixture", { pid: 123 })).toMatchObject({ processes: [{ pid: 123 }] });
  current = true;
  const text: any = await client.fsRead("fixture", { path: file, length: 1 });
  expect(text).toMatchObject({ data: "é", bytesRead: 2, nextOffset: 2 });
});
it("negotiation diagnostics retain only 32 bounded observations", () => {
  const d = new SdkCompatibilityDiagnostics();
  for (let i = 0; i < 80; i++) d.observe({ send: async () => {}, start: async () => {}, close: async () => {} }, "legacy-stateless", "sse");
  expect(d.snapshot().observations).toHaveLength(32);
  expect(d.snapshot().observations.every(o => o.protocolVersion === null && o.source === "not_negotiated")).toBe(true);
});
