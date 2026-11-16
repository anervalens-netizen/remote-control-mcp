import { createServer, type RequestListener } from "node:http";
import { afterEach, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return new AgentClient([{ name: "fixture", url: "http://127.0.0.1:" + (server.address() as { port: number }).port }]);
}

it("classifies a truncated HTTP JSON body as transport failure after receiving headers", async () => {
  const client = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    res.write('{"ok":');
    setTimeout(() => res.destroy(), 25);
  });
  await expect(client.requestRoute("fixture", "/v1/info", undefined, "system", { timeoutMs: 1000, observeOperation: false }))
    .rejects.toMatchObject({ kind: "network" });
  expect(dispatchesFor(client).snapshot().total).toMatchObject({
    started: 1, responses: 1, finished: 1, networkErrors: 1, protocolErrors: 0, timeouts: 0, cancelled: 0,
  });
});

it("keeps complete malformed JSON as a protocol failure", async () => {
  const client = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"invalid":}');
  });
  await expect(client.requestRoute("fixture", "/v1/info", undefined, "system", { timeoutMs: 1000, observeOperation: false }))
    .rejects.toMatchObject({ kind: "protocol" });
  expect(dispatchesFor(client).snapshot().total).toMatchObject({
    started: 1, responses: 1, finished: 1, protocolErrors: 1, networkErrors: 0, timeouts: 0, cancelled: 0,
  });
});
