import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import {
  encodeIngressHeader, ingressCorrelationHeader, ingressReceiptHeader, parseIngressCorrelation,
} from "../packages/protocol/src/ingress-correlation.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const fixture = () => new AgentClient([{ name: "fixture", url: "http://fixture.invalid", userUrl: "http://fixture.invalid" }]);
const collect = async (chunks: AsyncIterable<Buffer>) => {
  const output: Buffer[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return Buffer.concat(output).toString();
};
const summary = (client: AgentClient) => dispatchesFor(client).snapshot();

it("correlates raw requests and finishes only after complete body consumption", async () => {
  const instanceId = randomUUID();
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
    expect(options.redirect).toBe("error");
    const header = new Headers(options.headers).get(ingressCorrelationHeader);
    const correlation = parseIngressCorrelation(header).value!;
    expect(correlation.dispatchId).toMatch(/^[a-f0-9-]{36}$/);
    return new Response("fixture", { headers: {
      "content-length": "7",
      [ingressReceiptHeader]: encodeIngressHeader({
        version: 1, instanceId, sequence: 1, eventId: instanceId + ":1", dispatchId: correlation.dispatchId,
      }),
    } });
  }));
  const client = fixture();
  const raw = await client.rawFile("fixture", "/private-fixture-path", "user");
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 0, receiptMatched: 1 });
  expect(await collect(raw.chunks)).toBe("fixture");
  await raw.cancel();
  await raw.cancel();
  const result = summary(client);
  expect(result.total).toMatchObject({ started: 1, responses: 1, finished: 1, cancelled: 0, receiptMatched: 1 });
  expect(result.samples).toHaveLength(1);
  expect(result.samples[0]).toMatchObject({ route: "/v1/fs", identity: "owner", outcome: "success", receiptState: "matched" });
  expect(JSON.stringify(result)).not.toContain("/private-fixture-path");
});

it.each([["missing", undefined], ["invalid", "not-a-valid-receipt"]] as const)(
  "retains streaming compatibility with a %s receipt", async (state, receipt) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", {
      headers: { "content-length": "2", ...(receipt ? { [ingressReceiptHeader]: receipt } : {}) },
    })));
    const client = fixture();
    const raw = await client.rawFile("fixture", "fixture");
    expect(await collect(raw.chunks)).toBe("ok");
    expect(summary(client).samples[0]).toMatchObject({ outcome: "success", receiptState: state });
    expect(summary(client).total).toMatchObject({ started: 1, finished: 1 });
  },
);

it.each([["short", "a", "2"], ["long", "abc", "2"]] as const)(
  "counts a %s body as one protocol failure", async (_kind, body, length) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-length": length } })));
    const client = fixture();
    const raw = await client.rawFile("fixture", "fixture");
    await expect(collect(raw.chunks)).rejects.toThrow();
    await raw.cancel();
    expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, protocolErrors: 1, cancelled: 0 });
    expect(summary(client).samples[0]?.outcome).toBe("protocol");
  },
);

it.each([
  ["missing body", () => new Response(null, { headers: { "content-length": "0" } })],
  ["invalid length", () => new Response("ok", { headers: { "content-length": "invalid" } })],
  ["missing length", () => new Response("ok")],
] as const)("counts %s as one protocol failure", async (_kind, response) => {
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  const client = fixture();
  await expect(client.rawFile("fixture", "fixture")).rejects.toMatchObject({ kind: "protocol" });
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, protocolErrors: 1 });
});

it("counts a consumer break after all advertised bytes as a completed read", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture", { headers: { "content-length": "7" } })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture");
  for await (const _chunk of raw.chunks) break;
  await raw.cancel();
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, cancelled: 0, protocolErrors: 0 });
  expect(summary(client).samples[0]?.outcome).toBe("success");
});

it("counts a consumer break before all advertised bytes as cancelled", async () => {
  const cancelled = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("part")); }, cancel: cancelled,
  }), { headers: { "content-length": "8" } })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture");
  for await (const _chunk of raw.chunks) break;
  await raw.cancel();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(summary(client).total).toMatchObject({ started: 1, finished: 1, cancelled: 1, protocolErrors: 0 });
});

it("cancels a never-iterated body when its deadline expires", async () => {
  vi.useFakeTimers();
  const cancelled = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
    headers: { "content-length": "4" },
  })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture", "system", 25);
  await vi.advanceTimersByTimeAsync(25);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(cancelled.mock.calls[0]?.[0]).toMatchObject({ name: "TimeoutError" });
  await raw.cancel();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(summary(client).total).toMatchObject({ started: 1, finished: 1, timeouts: 1, cancelled: 0, networkErrors: 0 });
});

it("counts explicit cancellation before iteration once", async () => {
  const cancelled = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), {
    headers: { "content-length": "4" },
  })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture");
  await raw.cancel();
  await raw.cancel();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, cancelled: 1 });
});

it("preserves a fetch failure while counting one network failure", async () => {
  const failure = new TypeError("synthetic network failure");
  vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
  const client = fixture();
  await expect(client.rawFile("fixture", "fixture")).rejects.toBe(failure);
  expect(summary(client).total).toMatchObject({ started: 1, responses: 0, finished: 1, networkErrors: 1 });
});

it("counts an interrupted successful body as one network failure", async () => {
  const failure = new TypeError("synthetic interrupted body");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(failure); },
  }), { headers: { "content-length": "4" } })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture");
  await expect(collect(raw.chunks)).rejects.toBe(failure);
  await raw.cancel();
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, networkErrors: 1, cancelled: 0 });
});

it("preserves a bounded HTTP error and counts it once", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "ENOENT", error: "synthetic missing file" }, { status: 404 })));
  const client = fixture();
  await expect(client.rawFile("fixture", "fixture")).rejects.toMatchObject({ kind: "http", status: 404, agentCode: "ENOENT" });
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, httpErrors: 1, networkErrors: 0 });
});

it("counts a deadline before headers once", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: URL, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  })));
  const client = fixture();
  const pending = client.rawFile("fixture", "fixture", "system", 25).catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toMatchObject({ kind: "timeout" });
  expect(summary(client).total).toMatchObject({ started: 1, responses: 0, finished: 1, timeouts: 1, networkErrors: 0 });
});

it.each([false, true])("counts a body deadline once when iteration has started=%s", async started => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { options.signal?.addEventListener("abort", () => controller.error(options.signal?.reason), { once: true }); },
  }), { headers: { "content-length": "4" } })));
  const client = fixture();
  const raw = await client.rawFile("fixture", "fixture", "system", 25);
  const pending = started ? collect(raw.chunks).catch(error => error) : undefined;
  await vi.advanceTimersByTimeAsync(25);
  if (pending) expect(await pending).toBeInstanceOf(Error);
  await raw.cancel();
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, timeouts: 1, networkErrors: 0, cancelled: 0 });
});

it("counts an interrupted HTTP error body by its timeout rather than twice", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { options.signal?.addEventListener("abort", () => controller.error(options.signal?.reason), { once: true }); },
  }), { status: 500 })));
  const client = fixture();
  const pending = client.rawFile("fixture", "fixture", "system", 25).catch(error => error);
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toMatchObject({ kind: "timeout" });
  expect(summary(client).total).toMatchObject({ started: 1, responses: 1, finished: 1, timeouts: 1, httpErrors: 0, networkErrors: 0 });
});
