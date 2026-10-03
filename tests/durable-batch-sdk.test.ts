import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { DurableBatchStore } from "../apps/mcp-server/src/durable-batch.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
it.each([false, true])("SDK advertises and accepts durable batch/recovery contracts (HTTP=%s)", async http => {
  const agent = Fastify(); let effects = 0;
  agent.get("/v1/info", async () => ({ runtime: { capabilities: ["job-key-recovery-v1"] } }));
  agent.post("/v1/jobs/start", async () => ({ id: `job-${++effects}`, state: "completed", exitCode: 7 }));
  agent.post("/v1/jobs/status", async req => ({ id: (req.body as any).id, state: "completed", exitCode: 7 }));
  const url = await agent.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => agent.close());
  const backend = new AgentClient([{ name: "fixture", url }]);
  async function connect() {
    const client = new Client({ name: "batch-fixture", version: "1" });
    if (http) {
      const server = createMcpHttpServer(backend, { token: "synthetic-token" });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as any).port}/mcp`), { requestInit: { headers: { Authorization: "Bearer synthetic-token" } } });
      await client.connect(transport);
      closers.push(async () => { await transport.terminateSession(); await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    } else {
      const server = new McpServer({ name: "batch-fixture", version: "1" }); registerTools(server, backend);
      const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
      closers.push(async () => { await client.close(); await server.close(); });
    }
    const catalog = await client.listTools(); expect(catalog.tools.find(t => t.name === "batch_recover")?.outputSchema).toBeDefined(); return client;
  }
  const first = await connect(), key = randomUUID();
  const missing = await first.callTool({ name: "batch_exec", arguments: { items: [{ device: "fixture", command: "synthetic" }] } });
  expect(missing.isError).toBe(true); expect(effects).toBe(0);
  const result = await first.callTool({ name: "batch_exec", arguments: { operationKey: key, items: [{ device: "fixture", command: "synthetic" }] } });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({ items: [{ state: "failed", exitCode: 7, verification: "unknown" }], clientAcceptance: "unknown" });
  const second = await connect();
  const recovered = await second.callTool({ name: "batch_recover", arguments: { operationKey: key } });
  expect(recovered.isError).not.toBe(true); expect(recovered.structuredContent).toMatchObject({ recoveryOnly: true, items: [{ state: "failed", exitCode: 7 }] });
  expect(effects).toBe(1);
}, 15000);


it.each(["batch_recover", "batch_exec"])("SDK cancellation reaches active recovery through %s", async tool => {
  const backend = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  const info = vi.spyOn(backend, "info").mockResolvedValue({ runtime: { capabilities: ["job-key-recovery-v1"] } });
  let starts = 0;
  const start = vi.spyOn(backend, "jobStart").mockImplementation(async () => ({ id: `job-${++starts}`, state: "running" }));
  const cancel = vi.spyOn(backend, "jobCancel");
  const key = randomUUID(), items = Array.from({ length: 8 }, (_, i) => ({ device: "fixture", command: `synthetic-${i}` }));
  await new DurableBatchStore(backend, process.env.RCMCP_STATE_DIR!).start(key, items.map(({ device, command }) => ({ device, target: "system", request: { command } })));
  const entered = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const status = vi.spyOn(backend, "jobStatus").mockImplementation(async (_device, _id, _context, options) => {
    const signal = options!.signal!; signals.push(signal);
    if (signals.length === 4) entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const recover = DurableBatchStore.prototype.recover;
  const observed = vi.spyOn(DurableBatchStore.prototype, "recover").mockImplementation(async function (this: DurableBatchStore, input, signal) {
    try { return await recover.call(this, input, signal); } finally { drained.resolve(); }
  });
  const server = new McpServer({ name: "batch-cancellation", version: "1" }); registerTools(server, backend);
  const client = new Client({ name: "batch-cancellation", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const controller = new AbortController();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const pending = client.callTool({ name: tool, arguments: { operationKey: key, ...(tool === "batch_exec" ? { items } : {}) } }, undefined, { signal: controller.signal });
    const cancelled = expect(pending).rejects.toThrow();
    await entered.promise; controller.abort(); await cancelled; await drained.promise;
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal.aborted && signal === observed.mock.calls[0]![1])).toBe(true);
    expect(start).toHaveBeenCalledTimes(8); expect(cancel).not.toHaveBeenCalled();
  } finally {
    controller.abort(); await client.close(); await server.close();
    for (const spy of [info, start, status, cancel, observed]) spy.mockRestore();
  }
});
