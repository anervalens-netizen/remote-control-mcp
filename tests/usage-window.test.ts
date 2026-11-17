import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { registerAgentIngress } from "../apps/agent/src/ingress-http.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { AgentDispatchObserver, dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import { UsageWindows, windowLimits } from "../apps/mcp-server/src/usage-windows.ts";
import { registerUsageTools } from "../apps/mcp-server/src/usage-tools.ts";
import { encodeIngressHeader } from "../packages/protocol/src/ingress-correlation.ts";

const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (closes.length) await closes.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const token = randomUUID();
  const app = Fastify();
  const ingress = registerAgentIngress(app, { token, allowUnauthenticated: false, identity: "root", instanceId: randomUUID() });
  app.addHook("onRequest", async (req, reply) => { if (req.headers.authorization !== "Bearer " + token) return reply.code(401).send({ error: "unauthorized" }); });
  app.get("/v1/info", async () => ({ ok: true }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  closes.push(() => app.close());
  const agent = new AgentClient([{ name: "fixture", aliases: ["alias"], url, token }, { name: "other", url, token }]);
  const server = new McpServer({ name: "window-fixture", version: "1" });
  const registration = vi.spyOn(server, "registerTool");
  registerUsageTools(server, agent);
  const sdk = new Client({ name: "window-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), sdk.connect(ct)]);
  closes.push(async () => { await sdk.close(); await server.close(); });
  const call = async (action: string, windowId?: string, extra = {}) => {
    const result = await sdk.callTool({ name: "usage_window", arguments: { device: "fixture", identity: "root", action, ...(windowId ? { windowId } : {}), ...extra } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return (result.structuredContent as any);
  };
  return { app, ingress, agent, sdk, call, registration };
}

it("advertises a bounded read-only SDK workflow with exact sequence boundaries and retained envelopes despite unrelated ring churn", async () => {
  const { agent, call, sdk, ingress, app } = await fixture();
  expect((await sdk.listTools()).tools.find(t => t.name === "usage_window")?.annotations?.readOnlyHint).toBe(true);
  // Historical detail must not hide a short new window. No disk state or installed agent.
  for (let i = 0; i < 40; i++) await agent.info("fixture", "system");
  const start = (await call("open")).report;
  await agent.info("fixture", "system");
  const original = dispatchesFor(agent).snapshot("fixture").samples.at(-1)!;
  for (let i = 0; i < 140; i++) {
    const o = dispatchesFor(agent);
    const c = { version: 1 as const, controllerInstanceId: o.instanceId, dispatchId: randomUUID() };
    o.finish(o.begin("other", "system", "/v1/info", c), "success");
  }
  expect(dispatchesFor(agent).snapshot("fixture").samples.some(s => s.dispatchId === original.dispatchId)).toBe(false);
  // Direct request is counted in the same denominator and remains unattributed.
  await app.inject({ method: "GET", url: "/v1/info" });
  const closed = (await call("close", start.windowId, { detailLimit: 16 })).report;
  expect(closed).toMatchObject({ state: "closed", agentDenominator: 3, complete: true, missingEventDetail: 0,
    reconciliation: { attributed: 2, unattributed: 1, collectionResidual: 0 } });
  expect(closed.dispatches.find((s: any) => s.dispatchId === original.dispatchId)).toEqual(original);
  expect(closed.start.sequence).toBe(start.start.sequence);
  expect(closed.end.sequence).toBe(ingress.snapshot().sequence);
  const count = ingress.snapshot().sequence;
  const read = (await call("read", start.windowId)).report;
  expect(read.dispatches).toEqual([]);
  expect(read.detailPage.nextOffset).toBeNull();
  expect(ingress.snapshot().sequence).toBe(count);
});

it("keeps burst eviction and bounded collection overflow explicit, with an exact conservation residual", async () => {
  const { call, app } = await fixture();
  const w = (await call("open")).report;
  for (let i = 0; i < 140; i++) await app.inject({ method: "GET", url: "/v1/info" });
  const r = (await call("close", w.windowId)).report;
  expect(r.agentDenominator).toBe(140 + r.reconciliation.attributed);
  expect(r.reconciliation.unattributed).toBe(140);
  expect(r.complete).toBe(false);
  expect(r.missingEventDetail).toBeGreaterThan(0);
  expect(r.collectionResidual).toBe(r.missingEventDetail);
  expect(r.reconciliation.collectionResidual).toBe(0);
  expect(r.reconciliation.attributed + r.reconciliation.unattributed).toBe(r.agentDenominator);
});

it("drains a hundred retained arrivals at close without losing the 32-event tail", async () => {
  const { call, app, ingress } = await fixture();
  const w = (await call("open")).report;
  for (let i = 0; i < 100; i++) await app.inject({ method: "GET", url: "/v1/info" });
  const result = await call("close", w.windowId);
  expect(result.agentStatus.state).toBe("available");
  expect(result.report).toMatchObject({ state: "closed", complete: true, agentDenominator: 104,
    missingEventDetail: 0, closeDeferred: false,
    reconciliation: { attributed: 4, unattributed: 100, collectionResidual: 0 } });
  expect(result.report.end.sequence).toBe(ingress.snapshot().sequence);
  expect(result.report.nextSampleAfterSequence).toBe(result.report.end.sequence);
});

it("defers close on a bounded partial-page producer and can retry without freezing a partial end", async () => {
  const { call, app, ingress } = await fixture();
  const w = (await call("open")).report;
  for (let i = 0; i < 60; i++) await app.inject({ method: "GET", url: "/v1/info" });
  const native = ingress.snapshot.bind(ingress);
  const limited = vi.spyOn(ingress, "snapshot").mockImplementation(options => {
    const result = native(options);
    return { ...result, samples: result.samples.slice(0, 1) };
  });
  const first = await call("close", w.windowId);
  expect(first.agentStatus.state).toBe("available");
  expect(first.report).toMatchObject({ state: "active", end: null, closeDeferred: true, complete: false });
  expect(first.report.agentSequencesBeyondCursor).toBeGreaterThan(0);
  limited.mockRestore();
  const second = await call("close", w.windowId);
  expect(second.report).toMatchObject({ state: "closed", closeDeferred: false,
    missingEventDetail: 0, complete: true, reconciliation: { unattributed: 60, collectionResidual: 0 } });
  expect(second.report.agentDenominator).toBe(72);
});

it("rejects aliases, wrong identity, invalid IDs and excessive output before agent dispatch", async () => {
  const { sdk, call, ingress } = await fixture();
  const w = (await call("open")).report;
  const before = ingress.snapshot().sequence;
  for (const extra of [{ device: "alias" }, { identity: "owner" }, { windowId: randomUUID() }, { detailLimit: 17 }]) {
    const r = await sdk.callTool({ name: "usage_window", arguments: { device: "fixture", identity: "root", action: "read", windowId: w.windowId, ...extra } });
    expect(r.isError).toBe(true);
  }
  expect(ingress.snapshot().sequence).toBe(before);
});

it("reports unsupported old agents and malformed data without reflecting private producer fields", async () => {
  const { call } = await fixture();
  for (const response of [Response.json({ version: 1, instanceId: randomUUID(), totals: { received: 1 }, history: {} }),
    new Response("PRIVATE_TEST_VALUE https://fixture.invalid/private", { status: 404 }),
    Response.json({ ...snapshot(1), samples: [null, {}, { eventId: "PRIVATE_TEST_VALUE" }] })]) {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const value = await call("open");
    expect(JSON.stringify(value)).not.toContain("PRIVATE_TEST_VALUE");
    expect(JSON.stringify(value)).not.toContain("https://fixture.invalid/private");
    if (value.agentStatus.state === "available") expect(value.report.invalidEventObservations).toBe(3);
    else expect(value.agentStatus.state).toBe("unsupported");
  }
});

const instanceId = randomUUID();
function snapshot(sequence: number, samples: unknown[] = [], overrides = {}) {
  return { version: 1, windowCollectionVersion: 1, identity: "root", instanceId, sequence, totals: { received: sequence },
    sampleCoverage: { retained: Math.min(sequence, 128), omitted: Math.max(0, sequence - 128), limit: 128 },
    counterScope: "current_process", observedAt: "2026-01-01T00:00:00.000Z", samples,
    coverage: { processCountsComplete: true, hookErrors: 0, faults: [] },
    history: { retentionDays: 90, collectionStartedAt: "2025-12-31T00:00:00.000Z", gaps: [{}], omittedGaps: 1 }, ...overrides };
}
function event(sequence: number, correlation?: any) {
  return { eventId: instanceId + ":" + sequence, identity: "root", instanceId, sequence, correlationInvalid: false, ...(correlation ? { correlation } : {}) };
}
function dispatch(o: AgentDispatchObserver, sequence: number, device = "fixture") {
  const correlation = { version: 1 as const, controllerInstanceId: o.instanceId, dispatchId: randomUUID() };
  const h = o.begin(device, "system", "/v1/fs/private?token=PRIVATE_TEST_VALUE", correlation);
  const receipt = { version: 1 as const, instanceId, sequence, eventId: instanceId + ":" + sequence, dispatchId: correlation.dispatchId };
  return { h, correlation, receipt };
}

it("distinguishes a valid but wrong agent identity from an unsupported contract", async () => {
  const { call } = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot(1, [], { identity: "owner" }))));
  const r = await call("open");
  expect(r.agentStatus).toMatchObject({ state: "error", reason: "identity_mismatch" });
  expect(r.report).toMatchObject({ state: "opening", start: null, agentDenominator: null, failedReads: 1 });
});

it("bounds window slots, detail retention and TTL; tracks saturation independently of historical gaps", () => {
  let now = 0;
  const o = new AgentDispatchObserver();
  const store = new UsageWindows(o, () => now);
  const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  for (let i = 0; i < 260; i++) {
    const { h, receipt, correlation } = dispatch(o, i + 2);
    o.response(h, 200, encodeIngressHeader(receipt)); o.finish(h, "success");
    store.ingest(w, snapshot(i + 2, [event(i + 2, correlation)]), false);
  }
  const r = store.report(w, 0, 16);
  expect(r).toMatchObject({ complete: false, currentCoverageGap: false, agentDenominator: 260,
    missingEventDetail: 4, droppedEventObservations: 4, reconciliation: { collectionResidual: 0 } });
  expect(r.droppedDispatchObservations).toBeGreaterThan(0);
  expect(r.dispatches).toHaveLength(16);
  expect(JSON.stringify(r)).not.toContain("PRIVATE_TEST_VALUE");
  for (let i = 1; i < windowLimits.windows; i++) store.open("fixture", "root");
  expect(() => store.open("fixture", "root")).toThrow("capacity");
  now = windowLimits.ttlMs;
  expect(() => store.get(w.id, "fixture", "root")).toThrow("unavailable");
  expect(store.open("fixture", "root").id).not.toBe(w.id);
  const fresh = new UsageWindows(new AgentDispatchObserver());
  expect(() => fresh.get(w.id, "fixture", "root")).toThrow("unavailable");
});

it("invalidates restart denominators, rejects regressing boundaries and keeps hook/saturation gaps explicit", () => {
  const store = new UsageWindows(new AgentDispatchObserver());
  const w = store.open("fixture", "root");
  expect(store.ingest(w, snapshot(2), false)).toBe(true);
  expect(store.ingest(w, snapshot(1), true)).toBe(false);
  expect(w.state).toBe("active");
  store.ingest(w, snapshot(3, [], { coverage: { processCountsComplete: false, hookErrors: 1, faults: ["counter_saturated"] } }), false);
  expect(store.report(w).currentCoverageGap).toBe(true);
  store.ingest(w, snapshot(1, [], { instanceId: randomUUID() }), true);
  expect(store.report(w)).toMatchObject({ state: "restart", processRestart: true, agentDenominator: null, reconciliation: null, complete: false });
});

it("deduplicates immutable events and excludes conflicts in either order; late cancelled dispatch receipts improve a closed window", () => {
  for (const reverse of [false, true]) {
    const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
    store.ingest(w, snapshot(1), false);
    const { h, correlation, receipt } = dispatch(o, 2);
    const first = event(2, correlation); const second = event(2, { ...correlation, traceId: randomUUID() });
    store.ingest(w, snapshot(2, reverse ? [second, first, first] : [first, first, second]), true);
    expect(store.report(w)).toMatchObject({ conflictingAgentEvents: 1, complete: false, reconciliation: { attributed: 0, collectionResidual: 0 } });
    o.response(h, 200, encodeIngressHeader(receipt)); o.finish(h, "cancelled");
    expect(store.report(w).lateDispatchObservations).toBe(2);
    expect(store.report(w).reconciliation?.attributed).toBe(0);
  }
  const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  const { h, correlation, receipt } = dispatch(o, 2);
  store.ingest(w, snapshot(2, [event(2, correlation)]), true);
  expect(store.report(w).reconciliation?.attributed).toBe(0);
  o.response(h, 200, encodeIngressHeader(receipt)); o.finish(h, "cancelled");
  expect(store.report(w, 0, 16)).toMatchObject({ complete: true, reconciliation: { attributed: 1, unattributed: 0 }, dispatches: [{ outcome: "cancelled" }] });
});

it("cancellation of a close read preserves the active window and never replays the request", async () => {
  const { registration, call, agent } = await fixture();
  const w = (await call("open")).report;
  const handler = registration.mock.calls.find(row => row[0] === "usage_window")![2] as any;
  const entered = Promise.withResolvers<void>();
  const fetch = vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }); entered.resolve();
  }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = handler({ device: "fixture", identity: "root", action: "close", windowId: w.windowId, detailOffset: 0, detailLimit: 0 }, { signal: controller.signal });
  const assertion = expect(pending).rejects.toThrow("synthetic cancellation");
  await entered.promise; controller.abort(new Error("synthetic cancellation")); await assertion;
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(dispatchesFor(agent).snapshot().total.cancelled).toBe(1);
  vi.unstubAllGlobals();
  expect((await call("read", w.windowId)).report.state).toBe("active");
  expect((await call("close", w.windowId)).report.state).toBe("closed");
});

it("captures a dispatch begun before opening when its original receipt arrives in-window, and exposes invalid/missing receipts", () => {
  const o = new AgentDispatchObserver();
  const before = dispatch(o, 2);
  const store = new UsageWindows(o); const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  o.response(before.h, 200, encodeIngressHeader(before.receipt)); o.finish(before.h, "success");
  const invalid = dispatch(o, 3); o.response(invalid.h, 200, "bad header"); o.finish(invalid.h, "cancelled");
  const missing = dispatch(o, 4); o.finish(missing.h, "cancelled");
  store.ingest(w, snapshot(4, [event(2, before.correlation), event(3), event(4)]), true);
  expect(store.report(w, 0, 16)).toMatchObject({ agentDenominator: 3, complete: false, receiptInvalid: 1,
    receiptMissing: 1, reconciliation: { attributed: 1, unattributed: 2, collectionResidual: 0 } });
  expect(store.report(w, 0, 16).dispatches[0]).toEqual(before.h.sample);
});

it("keeps conflicting dispatch bindings unassigned and rejects malformed revisions in either delivery order", () => {
  for (const reverse of [false, true]) {
    const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
    store.ingest(w, snapshot(1), false);
    const { h, correlation, receipt } = dispatch(o, 2);
    o.response(h, 200, encodeIngressHeader(receipt)); o.finish(h, "success");
    const second = o.begin("fixture", "system", "/v1/jobs", correlation);
    o.response(second, 200, encodeIngressHeader(receipt)); o.finish(second, "success");
    const valid = event(2, correlation); const invalid = { ...valid, correlation: { secret: "PRIVATE_TEST_VALUE" } };
    store.ingest(w, snapshot(2, reverse ? [invalid, valid] : [valid, invalid]), true);
    expect(store.report(w)).toMatchObject({ complete: false, invalidEventObservations: 1,
      reconciliation: { attributed: 0, conflictingAgentEvents: 1, conflictingDispatches: 1, collectionResidual: 0 } });
    expect(JSON.stringify(store.report(w, 0, 16))).not.toContain("PRIVATE_TEST_VALUE");
  }
});

it("incremental HTTP collection advances past prior pages; repeated close/read does not issue another dispatch", async () => {
  const { call, app, ingress } = await fixture();
  const w = (await call("open")).report;
  for (let i = 0; i < 60; i++) await app.inject({ method: "GET", url: "/v1/info" });
  const first = (await call("collect", w.windowId)).report;
  expect(first.missingEventDetail).toBe(29);
  const second = (await call("collect", w.windowId)).report;
  expect(second.missingEventDetail).toBe(0);
  const closed = (await call("close", w.windowId)).report;
  expect(closed).toMatchObject({ complete: true, agentDenominator: 63, reconciliation: { attributed: 3, unattributed: 60 } });
  const sequence = ingress.snapshot().sequence;
  expect((await call("close", w.windowId)).report.end).toEqual(closed.end);
  expect(ingress.snapshot().sequence).toBe(sequence);
});

it("does not let a failing diagnostic subscriber fail workload accounting", () => {
  const o = new AgentDispatchObserver();
  o.observe(() => { throw new Error("synthetic observer failure"); });
  const store = new UsageWindows(o); const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  const { h } = dispatch(o, 2);
  expect(o.finish(h, "success")).toBe(true);
  store.ingest(w, snapshot(2, [event(2)]), true);
  expect(o.snapshot().total.finished).toBe(1);
  expect(store.report(w)).toMatchObject({ complete: false, controllerObservationErrors: 2 });
});

it("retains cancelled no-receipt completion after close without assigning it an arrival identity", () => {
  const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  const { h } = dispatch(o, 2);
  store.ingest(w, snapshot(2, [event(2)]), true);
  expect(store.report(w).receiptPending).toBe(1);
  o.finish(h, "cancelled");
  expect(store.report(w, 0, 16)).toMatchObject({ receiptPending: 0, receiptMissing: 1,
    reconciliation: { attributed: 0, unattributed: 1 }, dispatches: [{ outcome: "cancelled" }] });
});

it("detects changed agent-instance diagnostics over actual HTTP without mixing lifetimes", async () => {
  const { call, ingress } = await fixture();
  const w = (await call("open")).report;
  const original = ingress.snapshot.bind(ingress);
  vi.spyOn(ingress, "snapshot").mockImplementation(options => ({ ...original(options), instanceId: randomUUID() }));
  const value = await call("close", w.windowId);
  expect(value.agentStatus.state).toBe("available");
  expect(value.report).toMatchObject({ state: "restart", processRestart: true, agentDenominator: null,
    denominatorExact: false, reconciliation: null, complete: false });
});

it("rejects wrong-identity event revisions and bounds serialized diagnostic detail", () => {
  const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
  store.ingest(w, snapshot(1), false);
  const { h, receipt, correlation } = dispatch(o, 2);
  o.response(h, 200, encodeIngressHeader(receipt)); o.finish(h, "success");
  store.ingest(w, snapshot(2, [event(2, correlation), { ...event(2, correlation), identity: "owner" }]), true);
  const r = store.report(w, 0, 16);
  expect(r).toMatchObject({ complete: false, invalidEventObservations: 1,
    reconciliation: { attributed: 0, conflictingAgentEvents: 1, collectionResidual: 0 } });
  expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(32_000);
});

it("keeps a receipt event reused by different dispatches unassigned in either delivery order", () => {
  for (const reverse of [false, true]) {
    const o = new AgentDispatchObserver(); const store = new UsageWindows(o); const w = store.open("fixture", "root");
    store.ingest(w, snapshot(1), false);
    const a = dispatch(o, 2); const b = dispatch(o, 2);
    for (const d of reverse ? [b, a] : [a, b]) { o.response(d.h, 200, encodeIngressHeader(d.receipt)); o.finish(d.h, "success"); }
    store.ingest(w, snapshot(2, [event(2, a.correlation)]), true);
    expect(store.report(w)).toMatchObject({ complete: false, duplicateReceiptBindings: 1, conflictingReceiptEvents: 1,
      reconciliation: { attributed: 0, unattributed: 1, collectionResidual: 0, inconsistent: true } });
  }
});
