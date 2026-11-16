import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { capabilityReport, registerCapabilityTools } from "../apps/mcp-server/src/capability-tools.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const inventory = ["one", "two", "three"].map(name => ({ name, url: "http://127.0.0.1:1" }));
function slowClient() {
  const calls: string[] = [];
  const client = new AgentClient(inventory, undefined, 0);
  vi.spyOn(client, "info").mockImplementation((name, _context, options) => {
    calls.push(name);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(options!.signal!.reason); };
      const timer = setTimeout(() => { cleanup(); resolve({ hostname: "late-fixture" }); }, 500);
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    });
  });
  return { client, calls };
}

it("bounds capability probes even when the generic RPC deadline is disabled", async () => {
  const { client } = slowClient();
  const started = performance.now();
  const [result] = await capabilityReport(client, ["one"], 1, { probeTimeoutMs: 100 });
  expect(result?.endpoints.system).toMatchObject({ ok: false, error: expect.stringContaining("budget") });
  expect(result?.probeBudgetMs).toBe(100);
  expect(performance.now() - started).toBeLessThan(450);
});

it("cancels in-flight capability reads and stops queued devices", async () => {
  const { client, calls } = slowClient();
  const controller = new AbortController();
  const pending = capabilityReport(client, undefined, 1, { probeTimeoutMs: 1000, signal: controller.signal });
  const rejection = expect(pending).rejects.toThrow();
  setTimeout(() => controller.abort(new Error("fixture caller stopped")), 20);
  await rejection;
  expect(calls).toEqual(["one"]);
  const before = calls.length;
  await expect(capabilityReport(client, undefined, 1, { signal: controller.signal })).rejects.toThrow("fixture caller stopped");
  expect(calls).toHaveLength(before);
});

it("uses the finite health-probe budget and keeps successful endpoint results", async () => {
  vi.stubEnv("RCMCP_HEALTH_PROBE_TIMEOUT_MS", "240");
  const client = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1", userUrl: "http://127.0.0.1:2" }], undefined, 0);
  const calls: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
  vi.spyOn(client, "info").mockImplementation(async (_name, context, options) => {
    calls.push({ timeoutMs: options?.timeoutMs, hasSignal: options?.signal instanceof AbortSignal });
    if (context === "user") throw new Error("fixture endpoint unavailable");
    return { runtime: { ready: true } };
  });
  const [result] = await capabilityReport(client);
  expect(result).toMatchObject({
    probeBudgetMs: 240, endpoints: {
      system: { ok: true, info: { runtime: { ready: true } } },
      user: { ok: false, error: "fixture endpoint unavailable" },
    },
  });
  expect(calls).toEqual([{ timeoutMs: 240, hasSignal: true }, { timeoutMs: 240, hasSignal: true }]);
});

it("advertises and forwards the capability budget through the actual SDK registration", async () => {
  const client = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  const info = vi.spyOn(client, "info").mockResolvedValue({ runtime: { ready: true } });
  const server = new McpServer({ name: "fixture-capabilities", version: "1" });
  registerCapabilityTools(server, client);
  const sdk = new Client({ name: "fixture-capabilities-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), sdk.connect(ct)]);
    const tool = (await sdk.listTools()).tools.find(item => item.name === "capability_report")!;
    expect(tool.inputSchema.properties).toHaveProperty("probeTimeoutMs");
    const rejected = await sdk.callTool({ name: "capability_report", arguments: { devices: ["fixture"], probeTimeoutMs: 0 } });
    expect(rejected.isError).toBe(true);
    expect(info).not.toHaveBeenCalled();
    const result = await sdk.callTool({ name: "capability_report", arguments: { devices: ["fixture"], probeTimeoutMs: 120 } });
    expect(result.isError).not.toBe(true);
    expect(info).toHaveBeenCalledWith("fixture", "system", expect.objectContaining({ timeoutMs: 120, signal: expect.any(AbortSignal) }));
  } finally { await sdk.close(); await server.close(); }
});

it("aborts a real stalled HTTP response without borrowing the execution timeout", async () => {
  const http = createServer((_request, _response) => { /* intentionally stalled synthetic info response */ });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const client = new AgentClient([{ name: "fixture", url: `http://127.0.0.1:${(http.address() as { port: number }).port}` }], undefined, 0);
  // This test runs after a separate finite-budget assertion; bound teardown too.
  const caller = new AbortController();
  const emergency = setTimeout(() => caller.abort(new Error("fixture safety deadline")), 1000);
  try {
    const [result] = await capabilityReport(client, undefined, 1, { probeTimeoutMs: 100, signal: caller.signal });
    expect(result).toMatchObject({ probeBudgetMs: 100, endpoints: { system: { ok: false, error: expect.stringContaining("budget") } } });
  } finally {
    clearTimeout(emergency);
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
}, 2000);
