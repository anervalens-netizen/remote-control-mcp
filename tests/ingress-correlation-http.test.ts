import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerAgentIngress } from "../apps/agent/src/ingress-http.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { AgentDispatchObserver, dispatchesFor, reconcileIngressSamples } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import { operationContext, OperationObserver } from "../apps/mcp-server/src/operation-observer.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import {
  encodeIngressHeader, ingressCorrelationHeader, ingressReceiptHeader, parseIngressCorrelation, parseIngressReceipt,
} from "../packages/protocol/src/ingress-correlation.ts";

const closers: (() => Promise<unknown>)[] = [];
const directories: string[] = [];
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "rcmcp-ingress-http-"));
  directories.push(value); return value;
}
beforeEach(async () => {
  vi.stubEnv("RCMCP_STATE_DIR", await directory());
  vi.stubEnv("RCMCP_CONTEXTKEEP_URL", "");
  vi.stubEnv("RCMCP_CONTEXTKEEP_TOKEN", "");
});
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true });
});
async function fixture(options: { allowUnauthenticated?: boolean; token?: string; identity?: "root" | "owner" | "interactive"; configure?: (app: FastifyInstance) => void } = {}) {
  const token = options.token ?? randomUUID();
  const app = Fastify();
  const identity = options.identity ?? "owner";
  const instanceId = randomUUID();
  const observer = registerAgentIngress(app, {
    token, allowUnauthenticated: options.allowUnauthenticated ?? false, identity, instanceId, stateDirectory: await directory(),
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health" || options.allowUnauthenticated) return;
    if (request.headers.authorization !== "Bearer " + token) return reply.code(401).send({ error: "unauthorized" });
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/v1/info", async () => ({ runtime: { instanceId, context: identity === "owner" ? "user" : "system", capabilities: [] } }));
  options.configure?.(app);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => app.close());
  const client = new AgentClient([{ name: "lab", aliases: ["lab-alias"], url, userUrl: url, desktopUrl: url, token }], token);
  return { app, observer, token, url, client, instanceId };
}
const correlation = () => ({
  version: 1 as const, controllerInstanceId: randomUUID(), dispatchId: randomUUID(), traceId: randomUUID(),
});

it("validates canonical correlation and receipt encodings without trusting inconsistent identities", () => {
  const input = correlation();
  expect(parseIngressCorrelation(encodeIngressHeader(input))).toEqual({ value: input, invalid: false });
  expect(parseIngressCorrelation(undefined)).toEqual({ invalid: false });
  for (const malformed of ["", "=", "not-json", "x".repeat(2049), [encodeIngressHeader(input)]]) {
    expect(parseIngressCorrelation(malformed).invalid).toBe(true);
  }
  expect(parseIngressCorrelation(Buffer.from(JSON.stringify({ ...input, identity: "root" })).toString("base64url")).invalid).toBe(true);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 2, eventId: instanceId + ":2", dispatchId: input.dispatchId };
  expect(parseIngressReceipt(encodeIngressHeader(receipt))).toEqual({ value: receipt, invalid: false });
  expect(parseIngressReceipt(encodeIngressHeader({ ...receipt, eventId: instanceId + ":3" })).invalid).toBe(true);
});

it("counts direct, unauthenticated and denied requests before auth while withholding private detail", async () => {
  const value = await fixture();
  const publicHealth = await value.app.inject({ method: "GET", url: "/health" });
  expect(publicHealth.statusCode).toBe(200);
  expect(publicHealth.headers[ingressReceiptHeader]).toBeUndefined();
  const denied = await value.app.inject({ method: "GET", url: "/v1/info" });
  expect(denied.statusCode).toBe(401);
  expect(denied.headers[ingressReceiptHeader]).toBeUndefined();
  const direct = await value.app.inject({ method: "GET", url: "/v1/info", headers: { authorization: "Bearer " + value.token } });
  expect(direct.statusCode).toBe(200);
  expect(parseIngressReceipt(direct.headers[ingressReceiptHeader]).value).toMatchObject({ instanceId: value.instanceId, sequence: 3 });
  const detailDenied = await value.app.inject({ method: "POST", url: "/v1/observations/ingress", payload: {} });
  expect(detailDenied.statusCode).toBe(401);
  expect(detailDenied.json()).toEqual({ error: "unauthorized" });
  const result = value.observer.snapshot();
  expect(result.totals).toMatchObject({ received: 4, completed: 4, inFlight: 0, response: 4 });
  expect(result.sources).toEqual(expect.arrayContaining([
    { entryPoint: "unattributed", authentication: "not_verified", received: 1, completed: 1 },
    { entryPoint: "unattributed", authentication: "rejected", received: 2, completed: 2 },
    { entryPoint: "unattributed", authentication: "bearer_verified", received: 1, completed: 1 },
  ]));
  expect(result.samples.every(sample => sample.identity === "owner")).toBe(true);
});

it("keeps private ingress history authenticated in deliberately unauthenticated workload mode", async () => {
  const value = await fixture({ allowUnauthenticated: true });
  expect((await value.app.inject({ method: "GET", url: "/v1/info" })).statusCode).toBe(200);
  const denied = await value.app.inject({ method: "POST", url: "/v1/observations/ingress", payload: {} });
  expect(denied.statusCode).toBe(401);
  const allowed = await value.app.inject({ method: "POST", url: "/v1/observations/ingress", headers: { authorization: "Bearer " + value.token }, payload: { sampleLimit: 1 } });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json()).toMatchObject({ instanceId: value.instanceId, identity: "owner", hookErrors: 0 });
  expect(allowed.json().samples).toHaveLength(1);
  expect(allowed.json().totals.inFlight).toBe(1); // The diagnostic request itself is still responding.
});

it("redacts unknown URLs and refuses malformed or spoofed correlation labels without changing actual identity", async () => {
  const value = await fixture({ identity: "owner" });
  const spoof = { ...correlation(), identity: "root", privateLabel: "PRIVATE_LABEL_SENTINEL" };
  await value.app.inject({
    method: "GET", url: "/PRIVATE_PATH_SENTINEL?value=PRIVATE_QUERY_SENTINEL",
    headers: { authorization: "Bearer " + value.token, [ingressCorrelationHeader]: Buffer.from(JSON.stringify(spoof)).toString("base64url") },
  });
  await value.app.inject({ method: "GET", url: "/v1/info", headers: { [ingressCorrelationHeader]: encodeIngressHeader(correlation()) } });
  await value.app.inject({ method: "GET", url: "/v1/info", headers: { authorization: "Bearer " + value.token, [ingressCorrelationHeader]: "malformed===" } });
  const result = value.observer.snapshot();
  expect(result.malformedCorrelations).toBe(2);
  expect(result.samples[0]).toMatchObject({ route: "other", identity: "owner", entryPoint: "unattributed", correlationInvalid: true });
  expect(result.samples[1]).toMatchObject({ identity: "owner", authentication: "rejected", entryPoint: "unattributed" });
  expect(result.samples.every(sample => sample.correlation === undefined)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_.*SENTINEL/);
  expect(JSON.stringify(result)).not.toContain(value.token);
});

it("correlates actual AgentClient attempts and preserves body, durable keys and task association", async () => {
  const received: unknown[] = [];
  const value = await fixture({ configure: app => app.post("/v1/jobs/start", async request => {
    received.push(request.body); return { id: "synthetic-job", state: "running" };
  }) });
  const journal = new OperationObserver();
  const contextKeep = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID() };
  const traceId = (await journal.begin("job_start", undefined, "synthetic-rpc-id", undefined, contextKeep))!;
  const input = { command: "synthetic-command-sentinel", idempotencyKey: "synthetic-durable-key", env: { example: "synthetic-env-sentinel" } };
  const result = await operationContext.run({ observer: journal, traceId }, () => value.client.jobStart("lab-alias", input, "user"));
  expect(result).toEqual({ id: "synthetic-job", state: "running" });
  await operationContext.run({ observer: journal, traceId }, () => value.client.jobStart("lab", input, "user"));
  expect(received).toEqual([input, input]);
  const agent = value.observer.snapshot();
  const controller = dispatchesFor(value.client).snapshot();
  expect(controller.total).toMatchObject({ started: 2, finished: 2, receiptMatched: 2, receiptMissing: 0, receiptInvalid: 0 });
  expect(agent.totals).toMatchObject({ received: 2, completed: 2 });
  expect(new Set(agent.samples.map(sample => sample.correlation?.dispatchId)).size).toBe(2);
  for (const sample of agent.samples) {
    expect(sample.correlation).toMatchObject({ controllerInstanceId: journal.controllerInstanceId, traceId, contextKeep, diagnosticScopeId: contextKeep.taskId });
    expect(sample).toMatchObject({ identity: "owner", entryPoint: "controller_claimed", authentication: "bearer_verified" });
  }
  expect(JSON.stringify({ agent, controller })).not.toMatch(/synthetic-command-sentinel|synthetic-env-sentinel|synthetic-durable-key/);
  expect(reconcileIngressSamples(agent.totals.received, agent.samples, controller.samples)).toMatchObject({
    agentTotal: 2, attributed: 2, unmatchedObserved: 0, unsampled: 0, inconsistent: false,
  });
});

it("counts dispatches when operation admission is full or explicitly absent", async () => {
  const value = await fixture();
  const full = new OperationObserver(undefined, 1);
  expect(await full.begin("exec", undefined)).toBeTruthy();
  expect(await full.begin("device_info", undefined)).toBeUndefined();
  expect((await full.health()).counters.admissionRefused).toBe(1);
  await operationContext.run({ observer: full, traceId: randomUUID() }, () => value.client.info("lab", "user"));
  await value.client.info("lab", "user", { observeOperation: false });
  const agent = value.observer.snapshot();
  expect(agent.totals.received).toBe(2);
  expect(agent.samples.every(sample => sample.correlation?.traceId === undefined)).toBe(true);
  expect(dispatchesFor(value.client).snapshot().total).toMatchObject({ started: 2, finished: 2, receiptMatched: 2 });
});

it("counts every agent dispatch from one actual MCP batch call", async () => {
  const bodies: unknown[] = [];
  const value = await fixture({ configure: app => app.post("/v1/jobs/start", async request => {
    bodies.push(request.body); return { id: randomUUID(), state: "running" };
  }) });
  const agent = new AgentClient(["lab-one", "lab-two", "lab-three"].map(name => ({ name, url: value.url, token: value.token })));
  const server = new McpServer({ name: "synthetic-ingress-batch", version: "1" });
  registerJobTools(server, agent);
  const client = new Client({ name: "synthetic-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "job_start_many", arguments: {
    devices: ["lab-one", "lab-two", "lab-three"], command: "synthetic-command", idempotencyKey: "synthetic-batch-key", concurrency: 2,
  } });
  expect(result.isError).not.toBe(true);
  expect((result.structuredContent as any).items).toHaveLength(3);
  expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ command: "synthetic-command", idempotencyKey: "synthetic-batch-key" })));
  expect(dispatchesFor(agent).snapshot().total).toMatchObject({ started: 3, finished: 3, receiptMatched: 3 });
  expect(value.observer.snapshot().totals.received).toBe(3);
});

it("keeps denominators after controller and agent trace sampling roll over", async () => {
  const value = await fixture();
  for (let batch = 0; batch < 17; batch++) {
    await Promise.all(Array.from({ length: 8 }, () => value.client.info("lab", "user", { observeOperation: false })));
  }
  const agent = value.observer.snapshot();
  const controller = dispatchesFor(value.client).snapshot();
  expect(agent.totals).toMatchObject({ received: 136, completed: 136 });
  expect(controller.total).toMatchObject({ started: 136, finished: 136, receiptMatched: 136 });
  expect(agent.samples).toHaveLength(128);
  expect(controller.samples).toHaveLength(128);
  expect(agent.sampleCoverage.omitted).toBe(8);
  const comparison = reconcileIngressSamples(136, agent.samples, controller.samples);
  expect(comparison.agentTotal).toBe(comparison.attributed + comparison.unattributed);
  expect(comparison.unattributed).toBe(comparison.unmatchedObserved + comparison.unsampled);
  expect(comparison.collectionResidual).toBe(0);
  expect(comparison.unsampled).toBe(8);
});

it("deduplicates delivered observations and rejects mismatched receipt associations", () => {
  const value = new AgentDispatchObserver(2, 1);
  const input = correlation();
  const dispatch = value.begin("lab", "user", "/v1/jobs/status?private=PRIVATE_SENTINEL", input);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: input.dispatchId };
  value.response(dispatch, 200, encodeIngressHeader(receipt));
  value.response(dispatch, 200, encodeIngressHeader(receipt));
  expect(value.finish(dispatch, "success")).toBe(true);
  expect(value.finish(dispatch, "success")).toBe(false);
  const snapshot = value.snapshot();
  const event = { eventId: receipt.eventId, correlation: input };
  expect(snapshot.total).toMatchObject({ started: 1, finished: 1, responses: 1, receiptMatched: 1 });
  expect(snapshot.samples[0]?.route).toBe("/v1/jobs");
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_SENTINEL");
  expect(reconcileIngressSamples(1, [event, event], [snapshot.samples[0]!, snapshot.samples[0]!])).toMatchObject({
    attributed: 1, unmatchedObserved: 0, duplicateAgentDeliveries: 1, collectionResidual: 0,
  });
  expect(reconcileIngressSamples(1, [{ ...event, correlation: { ...input, controllerInstanceId: randomUUID() } }], snapshot.samples).attributed).toBe(0);
  expect(reconcileIngressSamples(1, [{ ...event, correlation: { ...input, dispatchId: randomUUID() } }], snapshot.samples).attributed).toBe(0);
  const invalid = value.begin("lab", "user", "/v1/info", correlation());
  value.response(invalid, 200, encodeIngressHeader(receipt)); value.finish(invalid, "success");
  expect(value.snapshot().total).toMatchObject({ receiptMatched: 1, receiptInvalid: 1 });
  expect(reconcileIngressSamples(0, [event], snapshot.samples).inconsistent).toBe(true);
});

it("keeps HTTP failure, invalid JSON and old-agent missing receipts separate", async () => {
  const value = await fixture({ configure: app => {
    app.get("/v1/failure", async (_, reply) => reply.code(503).send({ error: "synthetic_unavailable" }));
    app.get("/v1/invalid", async (_, reply) => reply.type("application/json").send("not json"));
  } });
  await expect(value.client.requestRoute("lab", "/v1/failure", undefined, "user")).rejects.toMatchObject({ kind: "http", status: 503 });
  await expect(value.client.requestRoute("lab", "/v1/invalid", undefined, "user")).rejects.toMatchObject({ kind: "protocol" });
  expect(dispatchesFor(value.client).snapshot().total).toMatchObject({ started: 2, finished: 2, httpErrors: 1, protocolErrors: 1, receiptMatched: 2 });
  const legacy = Fastify();
  legacy.get("/v1/info", async () => ({ runtime: { capabilities: [] } }));
  const url = await legacy.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => legacy.close());
  const oldClient = new AgentClient([{ name: "legacy", url }], "");
  expect(await oldClient.info("legacy")).toEqual({ runtime: { capabilities: [] } });
  expect(dispatchesFor(oldClient).snapshot().total).toMatchObject({ started: 1, finished: 1, receiptMissing: 1, receiptInvalid: 0 });
});

it("distinguishes caller cancellation from successful response completion without duplicate execution", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const value = await fixture({ configure: app => {
    app.get("/v1/pending", async () => { calls++; entered.resolve(); await release.promise; return { ok: true }; });
  } });
  const controller = new AbortController();
  const request = value.client.requestRoute("lab", "/v1/pending", undefined, "user", { signal: controller.signal });
  const rejected = expect(request).rejects.toMatchObject({ kind: "cancelled" });
  try {
    await entered.promise; controller.abort(); await rejected;
    await vi.waitFor(() => expect(value.observer.snapshot().totals).toMatchObject({ received: 1, completed: 1, disconnected: 1, response: 0 }), { timeout: 2000, interval: 10 });
    expect(dispatchesFor(value.client).snapshot().total).toMatchObject({ started: 1, finished: 1, cancelled: 1 });
    expect(calls).toBe(1);
  } finally { release.resolve(); }
  const completed = new AbortController();
  await value.client.info("lab", "user", { signal: completed.signal });
  completed.abort();
  expect(value.observer.snapshot().totals).toMatchObject({ received: 2, completed: 2, disconnected: 1, response: 1 });
  expect(dispatchesFor(value.client).snapshot().total.cancelled).toBe(1);
});

it("records controller deadlines separately from agent-observed disconnection", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const value = await fixture({ configure: app => app.get("/v1/pending", async () => {
    entered.resolve(); await release.promise; return { ok: true };
  }) });
  const request = value.client.requestRoute("lab", "/v1/pending", undefined, "user", { timeoutMs: 250 });
  const rejected = expect(request).rejects.toMatchObject({ kind: "timeout" });
  try {
    await entered.promise; await rejected;
    await vi.waitFor(() => expect(value.observer.snapshot().totals.disconnected).toBe(1), { timeout: 2000, interval: 10 });
    expect(value.observer.snapshot().totals.timeout).toBe(0);
    expect(dispatchesFor(value.client).snapshot().total).toMatchObject({ started: 1, finished: 1, timeouts: 1, cancelled: 0 });
  } finally { release.resolve(); }
});

it("uses a new agent instance after restart while retaining the controller attempt denominator", async () => {
  const first = await fixture();
  await first.client.info("lab", "user");
  const firstReceipt = dispatchesFor(first.client).snapshot().samples[0]!.receipt!;
  await first.app.close();
  const second = await fixture({ token: first.token });
  first.client.devices[0]!.url = second.url;
  first.client.devices[0]!.userUrl = second.url;
  await first.client.info("lab", "user");
  const result = dispatchesFor(first.client).snapshot();
  expect(result.total).toMatchObject({ started: 2, finished: 2, receiptMatched: 2 });
  expect(result.samples[1]!.receipt!.instanceId).not.toBe(firstReceipt.instanceId);
  expect(result.samples[1]!.receipt!.sequence).toBe(1);
  expect(new Set(result.samples.map(sample => sample.receipt!.eventId)).size).toBe(2);
});

it("advertises usage_report through the actual MCP catalog and returns bounded authenticated pages", async () => {
  const value = await fixture();
  await Promise.all(Array.from({ length: 20 }, () => value.client.info("lab", "user")));
  const server = new McpServer({ name: "synthetic-usage-report", version: "1" });
  registerTools(server, value.client);
  const client = new Client({ name: "synthetic-usage-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const advertised = (await client.listTools()).tools.find(tool => tool.name === "usage_report")!;
  expect(advertised).toBeDefined();
  expect(advertised.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect((advertised.inputSchema.properties?.sampleLimit as any).maximum).toBe(32);
  expect((advertised.inputSchema.properties?.seriesLimit as any).maximum).toBe(32);
  expect((advertised.inputSchema.properties?.historyLimit as any).maximum).toBe(14);
  const result = await client.callTool({ name: "usage_report", arguments: { device: "lab-alias", identity: "owner" } });
  expect(result.isError).not.toBe(true);
  const report = result.structuredContent as any;
  expect(report).toMatchObject({ version: 1, device: "lab", identity: "owner", agent: { instanceId: value.instanceId, hookErrors: 0 },
    comparison: { automaticSameWindowReconciliation: false } });
  expect(report.agent.samples).toHaveLength(16);
  expect(report.controller.samples).toHaveLength(16);
  expect(report.agent.series).toEqual([]);
  expect(report.agent.history.days.length).toBeLessThanOrEqual(7);
  expect(report.agent.samplePage.nextOffset).toBe(16);
  expect(report.controller.samplePage.nextOffset).toBe(16);
  expect(report.agent.totals.received).toBe(21);
  expect(report.agent.totals.inFlight).toBe(1);
  const page = await client.callTool({ name: "usage_report", arguments: {
    device: "lab", identity: "owner", sampleOffset: 1, sampleLimit: 1, seriesLimit: 1, historyLimit: 1,
  } });
  expect(page.isError).not.toBe(true);
  const next = page.structuredContent as any;
  expect(next.agent.samples).toHaveLength(1);
  expect(next.agent.samples[0].eventId).toBe(report.agent.samples[1].eventId);
  expect(next.agent.series).toHaveLength(1);
  expect(next.agent.seriesPage.nextOffset).toBe(1);
  const beforeInvalid = value.observer.snapshot().totals.received;
  const invalid = await client.callTool({ name: "usage_report", arguments: {
    device: "lab", identity: "owner", sampleLimit: 33,
  } }).catch(() => ({ isError: true }));
  expect(invalid.isError).toBe(true);
  expect(value.observer.snapshot().totals.received).toBe(beforeInvalid);
  expect(JSON.stringify(report)).not.toContain(value.token);
});

it("uses a terminal cursor for disabled sample pages in the actual usage_report result", async () => {
  const value = await fixture();
  await value.client.info("lab", "user");
  const server = new McpServer({ name: "synthetic-usage-empty-page", version: "1" });
  registerTools(server, value.client);
  const client = new Client({ name: "synthetic-empty-page-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "usage_report", arguments: {
    device: "lab", identity: "owner", sampleLimit: 0, seriesLimit: 0, historyLimit: 0,
  } });
  expect(result.isError).not.toBe(true);
  const report = result.structuredContent as any;
  expect(report.agent.samples).toEqual([]);
  expect(report.controller.samples).toEqual([]);
  expect(report.agent.samplePage.nextOffset).toBeNull();
  expect(report.controller.samplePage.nextOffset).toBeNull();
  expect(report.agent.seriesPage.nextOffset).toBeNull();
  expect(report.agent.history.page.nextOffset).toBeNull();
});

it("keeps conflicting duplicate agent events unattributed independent of delivery order", () => {
  const value = new AgentDispatchObserver();
  const input = correlation();
  const handle = value.begin("lab", "user", "/v1/info", input);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: input.dispatchId };
  value.response(handle, 200, encodeIngressHeader(receipt)); value.finish(handle, "success");
  const original = { eventId: receipt.eventId, correlation: input };
  const conflict = { ...original, correlation: { ...input, controllerInstanceId: randomUUID() } };
  const samples = value.snapshot().samples;
  const forward = reconcileIngressSamples(1, [original, conflict], samples);
  const reverse = reconcileIngressSamples(1, [conflict, original], samples);
  expect(forward).toEqual(reverse);
  expect(forward).toMatchObject({ agentTotal: 1, uniqueAgentEvents: 1, attributed: 0, unattributed: 1, unmatchedObserved: 1, duplicateAgentDeliveries: 1, conflictingAgentEvents: 1, collectionResidual: 0 });
  // A task/scope conflict is also contradictory evidence, even if transport IDs match.
  const differentTask = { ...original, correlation: { ...input, contextKeep: { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID() } } };
  expect(reconcileIngressSamples(1, [original, differentTask], samples).attributed).toBe(0);
});

it("keeps conflicting duplicate controller receipts unattributed independent of delivery order", () => {
  const value = new AgentDispatchObserver();
  const input = correlation();
  const handle = value.begin("lab", "user", "/v1/info", input);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: input.dispatchId };
  value.response(handle, 200, encodeIngressHeader(receipt)); value.finish(handle, "success");
  const original = value.snapshot().samples[0]!;
  const conflict = { ...original, receipt: { ...receipt, sequence: 2, eventId: instanceId + ":2" } };
  const event = { eventId: receipt.eventId, correlation: input };
  const forward = reconcileIngressSamples(1, [event], [original, conflict]);
  const reverse = reconcileIngressSamples(1, [event], [conflict, original]);
  expect(forward).toEqual(reverse);
  expect(forward).toMatchObject({ agentTotal: 1, uniqueAgentEvents: 1, attributed: 0, unattributed: 1, unmatchedObserved: 1, conflictingDispatches: 1, collectionResidual: 0 });
});

it("rejects conflicting immutable dispatch bindings even when the receipt event is unchanged", () => {
  const value = new AgentDispatchObserver();
  const input = correlation();
  const handle = value.begin("lab", "user", "/v1/info", input);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: input.dispatchId };
  value.response(handle, 200, encodeIngressHeader(receipt)); value.finish(handle, "success");
  const original = value.snapshot().samples[0]!;
  const event = { eventId: receipt.eventId, correlation: input };
  const variants = [
    { ...original, identity: "root" as const },
    { ...original, device: "different-lab" },
    { ...original, correlation: { ...original.correlation, traceId: randomUUID() } },
  ];
  for (const conflicting of variants) {
    expect(conflicting.dispatchId).toBe(original.dispatchId);
    expect(conflicting.receipt?.eventId).toBe(original.receipt?.eventId);
    const forward = reconcileIngressSamples(1, [event], [original, conflicting]);
    const reverse = reconcileIngressSamples(1, [event], [conflicting, original]);
    expect(forward).toEqual(reverse);
    expect(forward).toMatchObject({
      agentTotal: 1, attributed: 0, unattributed: 1, unmatchedObserved: 1,
      conflictingDispatches: 1, invalidDispatches: 0, inconsistent: true, collectionResidual: 0,
    });
  }
});

it("rejects unknown matched-dispatch correlation fields without throwing or attributing the request", () => {
  const value = new AgentDispatchObserver();
  const input = correlation();
  const handle = value.begin("lab", "user", "/v1/info", input);
  const instanceId = randomUUID();
  const receipt = { version: 1 as const, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: input.dispatchId };
  value.response(handle, 200, encodeIngressHeader(receipt)); value.finish(handle, "success");
  const original = value.snapshot().samples[0]!;
  const invalid = { ...original, correlation: { ...original.correlation, unknownField: "synthetic-extra-field" } };
  const result = reconcileIngressSamples(1, [{ eventId: receipt.eventId, correlation: input }], [invalid]);
  expect(result).toMatchObject({
    agentTotal: 1, attributed: 0, unattributed: 1, unmatchedObserved: 1,
    conflictingDispatches: 0, invalidDispatches: 1, inconsistent: true, collectionResidual: 0,
  });
});

it("keeps the operation available and reports incomplete coverage after an ingress hook fails", async () => {
  const value = await fixture();
  const brokenBegin = vi.spyOn(value.observer, "begin").mockImplementationOnce(() => {
    throw new Error("synthetic observer hook failure");
  });
  const operation = await value.app.inject({
    method: "GET", url: "/v1/info", headers: { authorization: "Bearer " + value.token },
  });
  brokenBegin.mockRestore();
  expect(operation.statusCode).toBe(200);
  expect(operation.json().runtime.instanceId).toBe(value.instanceId);
  expect(value.observer.snapshot().totals.received).toBe(0);
  const diagnostic = await value.app.inject({
    method: "POST", url: "/v1/observations/ingress",
    headers: { authorization: "Bearer " + value.token }, payload: { sampleLimit: 0 },
  });
  expect(diagnostic.statusCode).toBe(200);
  expect(diagnostic.json()).toMatchObject({
    hookErrors: 1, coverage: { processCountsComplete: false }, history: { partial: true },
    totals: { received: 1, completed: 0, inFlight: 1 },
  });
  // The diagnostic request is counted. The missed operation is not fabricated.
  expect(value.observer.snapshot().totals).toMatchObject({ received: 1, completed: 1 });
});
