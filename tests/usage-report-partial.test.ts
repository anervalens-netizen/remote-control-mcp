import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import { registerUsageTools } from "../apps/mcp-server/src/usage-tools.ts";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  while (closes.length) await closes.pop()!();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(agent = new AgentClient([{ name: "fixture", aliases: ["alias"], url: "http://fixture.invalid" }], undefined, 0)) {
  const server = new McpServer({ name: "partial-usage-fixture", version: "1" });
  const registration = vi.spyOn(server, "registerTool");
  registerUsageTools(server, agent);
  type UsageHandler = (input: { device: string; identity: "root"; sampleLimit: number }, extra: { signal: AbortSignal }) => Promise<unknown>;
  const registrations = registration.mock.calls as unknown as Array<[string, unknown, UsageHandler]>;
  const handler = registrations.find(([name]) => name === "usage_report")![2];
  const sdk = new Client({ name: "partial-usage-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), sdk.connect(ct)]);
  closes.push(async () => { await sdk.close(); await server.close(); });
  const read = () => sdk.callTool({ name: "usage_report", arguments: { device: "alias", identity: "root", sampleLimit: 2 } });
  return { sdk, read, agent, handler };
}
const snapshot = () => ({
  version: 1, instanceId: randomUUID(), identity: "root", totals: { received: 1 },
  history: { days: [] }, coverage: { processCountsComplete: true }, samples: [],
});
function report(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as any;
}

it("returns controller counters and explicit unsupported coverage for an older agent route", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "PRIVATE_FIXTURE_TOKEN https://fixture.invalid/private" }), { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const { read } = await fixture();
  const value = report(await read());
  expect(value).toMatchObject({ device: "fixture", identity: "root", agent: null,
    agentStatus: { state: "unsupported", reason: "route_unavailable", httpStatus: 404, timeoutMs: 5000 },
    controller: { total: { started: 1, finished: 1, httpErrors: 1 } },
    comparison: { automaticSameWindowReconciliation: false } });
  expect(value.controller.samples).toHaveLength(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(value)).not.toContain("PRIVATE_FIXTURE_TOKEN");
  expect(JSON.stringify(value)).not.toContain("https://fixture.invalid/private");
});

it("retains controller observations after an agent network failure without echoing diagnostics", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("PRIVATE_NETWORK_TOKEN http://fixture.invalid/private"); }));
  const { read } = await fixture();
  const value = report(await read());
  expect(value).toMatchObject({ agent: null, agentStatus: { state: "error", reason: "network_error" },
    controller: { total: { started: 1, finished: 1, networkErrors: 1 } } });
  expect(JSON.stringify(value)).not.toContain("PRIVATE_NETWORK_TOKEN");
});

it("retains controller observations after a server error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "fixture failure" }), { status: 503 })));
  const { read } = await fixture();
  const value = report(await read());
  expect(value).toMatchObject({ agent: null, agentStatus: { state: "error", reason: "http_error", httpStatus: 503 },
    controller: { total: { started: 1, httpErrors: 1 } } });
});

it("marks an incomplete success payload unsupported instead of claiming agent coverage", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ version: 1, instanceId: randomUUID(), totals: {} })));
  const { read } = await fixture();
  const value = report(await read());
  expect(value).toMatchObject({ agent: null, agentStatus: { state: "unsupported", reason: "unsupported_contract" },
    controller: { total: { started: 1, responses: 1 } } });
});

it("keeps the healthy path to one agent request and preserves agent coverage", async () => {
  const source = snapshot();
  const fetch = vi.fn(async (_url: string | URL, _options?: RequestInit) => Response.json(source));
  vi.stubGlobal("fetch", fetch);
  const { read, sdk } = await fixture();
  const tool = (await sdk.listTools()).tools.find(value => value.name === "usage_report")!;
  expect(tool.outputSchema?.properties).toHaveProperty("agentStatus");
  const value = report(await read());
  expect(value.agent).toEqual(source);
  expect(value.agentStatus).toMatchObject({ state: "available", timeoutMs: 5000 });
  expect(value.controller.total.started).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/v1/observations/ingress");
});

it.each(["owner", "unknown"])("does not assign %s producer coverage to the selected root route", async identity => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...snapshot(), identity })));
  const { read } = await fixture();
  expect(report(await read())).toMatchObject({ device: "fixture", identity: "root", agent: null,
    agentStatus: { state: "error", reason: "identity_mismatch" },
    controller: { total: { started: 1, responses: 1 } } });
});

it("retains the legacy usage_report schema and succeeds against old strict query fields", async () => {
  const source = snapshot();
  const allowed = new Set(["sampleOffset", "sampleLimit", "seriesOffset", "seriesLimit", "historyOffset", "historyLimit"]);
  const fetch = vi.fn(async (_url: string | URL, options: RequestInit) => {
    const fields = JSON.parse(String(options.body)) as Record<string, unknown>;
    return Object.keys(fields).every(key => allowed.has(key))
      ? Response.json(source)
      : Response.json({ error: "invalid_request" }, { status: 400 });
  });
  vi.stubGlobal("fetch", fetch);
  const { sdk, read } = await fixture();
  const tool = (await sdk.listTools()).tools.find(value => value.name === "usage_report")!;
  expect(tool.inputSchema.properties).not.toHaveProperty("sampleAfterSequence");
  expect(report(await read())).toMatchObject({ agentStatus: { state: "available" }, agent: source });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ sampleLimit: 2 });
  const rejected = await sdk.callTool({ name: "usage_report", arguments: {
    device: "alias", identity: "root", sampleAfterSequence: 5,
  } });
  expect(rejected.isError).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("returns bounded timeout coverage while retaining the attempted controller dispatch", async () => {
  const { read } = await fixture();
  const entered = Promise.withResolvers<void>();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: URL, options: RequestInit) => new Promise((_resolve, reject) => {
    const signal = options.signal!;
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    entered.resolve();
  })));
  const pending = read();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(5001);
  const value = report(await pending);
  expect(value).toMatchObject({ agent: null, agentStatus: { state: "timeout", reason: "deadline_exceeded", timeoutMs: 5000 },
    controller: { total: { started: 1, finished: 1, timeouts: 1 } } });
});

it("keeps previously observed dispatches when a later ingress refresh is unsupported", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => new URL(url).pathname === "/v1/info"
    ? Response.json({ runtime: { ready: true } })
    : new Response(JSON.stringify({ error: "route unavailable" }), { status: 404 })));
  const { read, agent } = await fixture();
  await agent.info("fixture", "system");
  const value = report(await read());
  expect(value.agentStatus.state).toBe("unsupported");
  expect(value.controller.total).toMatchObject({ started: 2, responses: 2, httpErrors: 1 });
  expect(value.controller.samples.map((row: { route: string }) => row.route)).toEqual(["/v1/info", "/v1/observations"]);
});

it("classifies completed malformed JSON as protocol_error while retaining safe controller evidence", async () => {
  const fetch = vi.fn(async () => new Response("PRIVATE_PROTOCOL_TOKEN https://fixture.invalid/private", {
    status: 200, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  const { read } = await fixture();
  const value = report(await read());
  expect(value).toMatchObject({ agent: null, agentStatus: { state: "error", reason: "protocol_error", timeoutMs: 5000 },
    controller: { total: { started: 1, finished: 1, responses: 1, protocolErrors: 1, networkErrors: 0, timeouts: 0 } } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(value)).not.toContain("PRIVATE_PROTOCOL_TOKEN");
  expect(JSON.stringify(value)).not.toContain("https://fixture.invalid/private");
});

it("reports unavailable ingress for a reverse transport without falling back to an HTTP endpoint", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const agent = new AgentClient([{ name: "fixture", aliases: ["alias"], url: "android-reverse://fixture", transport: "android-reverse" }]);
  const { sdk } = await fixture(agent);
  const value = report(await sdk.callTool({ name: "usage_report", arguments: { device: "alias", identity: "owner" } }));
  expect(value).toMatchObject({ device: "fixture", identity: "owner", agent: null,
    agentStatus: { state: "error", reason: "unavailable", timeoutMs: 5000 },
    controller: { total: { started: 0, finished: 0 }, samples: [] },
    comparison: { automaticSameWindowReconciliation: false } });
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects caller cancellation instead of returning a partial availability report", async () => {
  const entered = Promise.withResolvers<void>();
  let fetchSignal: AbortSignal | null | undefined;
  const fetch = vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    fetchSignal = options.signal;
    const abort = () => reject(fetchSignal!.reason);
    if (fetchSignal?.aborted) abort();
    else fetchSignal?.addEventListener("abort", abort, { once: true });
    entered.resolve();
  }));
  vi.stubGlobal("fetch", fetch);
  const { handler, agent } = await fixture();
  const caller = new AbortController();
  const reason = new DOMException("Synthetic caller cancelled", "AbortError");
  // Inspect the actual registered handler: the SDK suppresses late responses
  // after cancellation, which could conceal a mistakenly returned partial report.
  const pending = handler({ device: "alias", identity: "root", sampleLimit: 2 }, { signal: caller.signal });
  const rejected = expect(pending).rejects.toBe(reason);
  try {
    await entered.promise;
    caller.abort(reason);
    await rejected;
    expect(fetchSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dispatchesFor(agent).snapshot().total).toMatchObject({ started: 1, finished: 1, cancelled: 1, timeouts: 0 });
  } finally { caller.abort(reason); }
});
