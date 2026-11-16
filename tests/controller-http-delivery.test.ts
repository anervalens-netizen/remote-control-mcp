import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { createServer, request } from "node:http";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { httpDeliveryFor, HttpDeliveryObserver } from "../apps/mcp-server/src/http-delivery-observer.ts";
import { parseIngressCorrelation, ingressCorrelationHeader } from "../packages/protocol/src/ingress-correlation.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  close.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}

it("counts a disconnected SSE response with status 200 as incomplete, without claiming client acceptance", async () => {
  const agent = Fastify();
  let forwarded: ReturnType<typeof parseIngressCorrelation> | undefined;
  let received!: () => void;
  const admitted = new Promise<void>(resolve => { received = resolve; });
  agent.post("/v1/jobs/follow", async req => {
    forwarded = parseIngressCorrelation(req.headers[ingressCorrelationHeader]);
    received();
    await pause(180);
    const stream = { offset: 0, nextOffset: 0, totalBytes: 0, eof: true, data: "", bytes: 0, encoding: "utf8" };
    return { id: "fixture-job", state: "completed", startedAt: "2026-01-01T00:00:00.000Z", exitCode: 0,
      terminal: true, waitExpired: false, waitedMs: 180, outputComplete: true, cursor: { stdout: 0, stderr: 0 },
      stdout: { ...stream, stream: "stdout" }, stderr: { ...stream, stream: "stderr" } };
  });
  const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 }); close.push(() => agent.close());
  const client = new AgentClient([{ name: "fixture", url: agentUrl }]);
  const server = createMcpHttpServer(client, { token: "fixture-controller", sessionMode: "stateless", enableJsonResponse: false });
  const base = await listen(server);
  const before = await fetch(base + "/health/details", { headers: { authorization: "Bearer fixture-controller" } }).then(r => r.json()) as any;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 700, method: "tools/call",
    params: { name: "job_wait", arguments: { device: "fixture", identity: "root", id: "fixture-job", waitMs: 1000 },
      _meta: { progressToken: "fixture-progress" } } });
  let deliveryId: string | undefined;
  await new Promise<void>((resolve, reject) => {
    const req = request(base + "/mcp", { method: "POST", headers: {
      authorization: "Bearer fixture-controller", "content-type": "application/json",
      accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body),
      "mcp-protocol-version": "2025-03-26",
    } }, res => {
      deliveryId = res.headers["x-rcmcp-delivery-id"] as string;
      expect(res.statusCode).toBe(200);
      res.once("data", () => { void admitted.then(() => { res.destroy(); req.destroy(); resolve(); }); });
      res.on("error", () => {});
    });
    req.once("error", error => { if (!deliveryId) reject(error); });
    req.setTimeout(2500, () => { req.destroy(); reject(new Error("Synthetic SSE did not publish a progress event")); });
    req.end(body);
  });
  await admitted;
  for (let attempt = 0; attempt < 40 && httpDeliveryFor(client).snapshot().connectionsClosed === 0; attempt++) await pause(10);
  const health = await fetch(base + "/health/details", { headers: { authorization: "Bearer fixture-controller" } }).then(r => r.json()) as any;
  expect(health.requests.failed).toBeGreaterThan(before.requests.failed);
  expect(health.httpDelivery.connectionsClosed).toBe(1);
  const observed = health.httpDelivery.samples.find((s: any) => s.requestId === deliveryId);
  expect(observed).toMatchObject({ statusCode: 200, route: "/mcp", method: "POST", outcome: "connection_closed" });
  expect(health.httpDelivery.clientAcceptance).toBe("unknown");
  expect(forwarded?.value?.httpRequestId).toBe(deliveryId);
  expect(forwarded?.value?.dispatchId).toMatch(/^[a-f0-9-]{36}$/);
});

it("deduplicates finish then close and never stores unknown URLs, headers or caller IDs", async () => {
  const observer = new HttpDeliveryObserver();
  const server = createServer((req, res) => {
    const handle = observer.begin(req, "fixture-token");
    res.once("finish", () => observer.finish(handle, res, "response_finished"));
    res.once("close", () => observer.finish(handle, res, "connection_closed"));
    res.end("fixture");
  });
  const base = await listen(server);
  await fetch(base + "/private-path?secret=fixture-secret", { headers: { authorization: "Bearer fixture-token", "x-request-id": "private-caller-id" } }).then(r => r.text());
  const snapshot = observer.snapshot();
  expect(snapshot).toMatchObject({ started: 1, finished: 1, inFlight: 0, responseFinished: 1, connectionsClosed: 0 });
  expect(snapshot.samples[0]).toMatchObject({ route: "other", bearerVerified: true });
  expect(JSON.stringify(snapshot)).not.toMatch(/private-path|fixture-secret|fixture-token|private-caller-id/);
});
