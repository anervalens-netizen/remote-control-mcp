import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { DurableBatchStore, type BatchPlan } from "../apps/mcp-server/src/durable-batch.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

it.each([
  ["batch_recover", "id", true], ["batch_recover", "key", true],
  ["batch_exec", "id", true], ["batch_exec", "key", true],
  ["batch_recover", "id", false], ["batch_recover", "key", false],
  ["batch_exec", "id", false], ["batch_exec", "key", false],
] as const)("%s cancels %s recovery reads (already aborted=%s) without cancelling or replaying jobs", async (tool, lookup, alreadyAborted) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "batch-abort-"));
  const entered = Promise.withResolvers<void>(), disconnected = Promise.withResolvers<void>();
  const routes: string[] = []; let reads = 0, starts = 0, closed = 0;
  let manifest: Awaited<ReturnType<DurableBatchStore["start"]>>;
  const server = createServer(async (req, res) => {
    routes.push(req.url!);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/info") { res.end(JSON.stringify({ runtime: { capabilities: ["job-key-recovery-v1"] } })); return; }
    if (req.url === "/v1/jobs/start") {
      starts++;
      if (lookup === "key") { res.statusCode = 503; res.end('{}'); }
      else res.end(JSON.stringify({ id: `job-${starts}`, state: "running" }));
      return;
    }
    if (req.url === "/v1/jobs/status") {
      res.once("close", () => { if (++closed === 4) disconnected.resolve(); });
      if (++reads === 4) entered.resolve();
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const client = new AgentClient([{ name: "fixture", url: `http://127.0.0.1:${port}` }]);
    const plans: BatchPlan[] = Array.from({ length: 8 }, (_, i) => ({ device: "fixture", target: "system", request: { command: `synthetic-${i}` } }));
    manifest = await new DurableBatchStore(client, root).start("cancel-recovery", plans);
    const file = path.join(root, "batch-operations", manifest.operationId + ".json"), original = readFileSync(file, "utf8");
    const status = vi.spyOn(client, "jobStatus"), byKey = vi.spyOn(client, "jobStatusByKey"), cancel = vi.spyOn(client, "jobCancel");
    const handlers = new Map<string, (input: any, extra: any) => Promise<any>>();
    registerHighLevelTools({ registerTool: (name: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as unknown as McpServer, client);
    vi.stubEnv("RCMCP_STATE_DIR", root);
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const result = handlers.get(tool)!({ operationKey: "cancel-recovery", ...(tool === "batch_exec" ? { items: plans.map(p => ({ device: p.device, ...p.request })) } : {}) }, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    if (!alreadyAborted) { await entered.promise; controller.abort(); }
    const cancelledAt = performance.now();
    await rejected;
    expect(performance.now() - cancelledAt).toBeLessThan(1000);
    expect(reads).toBe(alreadyAborted ? 0 : 4);
    const requests = lookup === "id" ? status : byKey;
    expect(requests).toHaveBeenCalledTimes(reads);
    for (const args of requests.mock.calls) expect(args[3]?.signal).toBe(controller.signal);
    expect(lookup === "id" ? byKey : status).not.toHaveBeenCalled();
    if (!alreadyAborted) await disconnected.promise;
    expect(starts).toBe(8); expect(cancel).not.toHaveBeenCalled();
    expect(routes.every(route => ["/v1/info", "/v1/jobs/start", "/v1/jobs/status"].includes(route))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(original);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
  }
});
