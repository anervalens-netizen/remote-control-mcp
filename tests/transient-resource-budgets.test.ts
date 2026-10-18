import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock("sharp", () => ({ default: () => {
  const pipeline = {
    resize: () => pipeline, jpeg: () => pipeline, timeout: () => pipeline,
    destroy: () => {},
    toBuffer: () => new Promise(resolve => {
      fixture.pending.push(() => resolve({ data: Buffer.alloc(64), info: { width: 8, height: 8 } }));
    }),
  };
  return pipeline;
} }));
import { ResultRecoveryStore } from "../apps/mcp-server/src/result-recovery.ts";
import { deliverImages } from "../apps/mcp-server/src/image-delivery.ts";
afterEach(() => { vi.restoreAllMocks(); fixture.pending.length = 0; });
it("rejects oversized recovery JSON before allocating its serialized copy", () => {
  const store = new ResultRecoveryStore(2, 1, 8192);
  const slot = store.begin();
  const oversized = { output: "\u0000".repeat(32000) };
  const stringify = vi.spyOn(JSON, "stringify");
  const result = store.finish(slot.id, oversized);
  const serializedOriginal = stringify.mock.calls.some(([value]) => value === oversized);
  expect(result.payloadAvailable).toBe(false);
  expect(store.read(slot.id)).toMatchObject({ state: "complete" });
  expect(() => store.begin(slot.id)).toThrow(/already used/);
  expect(serializedOriginal).toBe(false);
});
it("caps native image transformations across simultaneous tool responses", async () => {
  const image = { type: "image", data: "x".repeat(400000), mimeType: "image/png" };
  const pending = Array.from({ length: 3 }, () => deliverImages([image], {}, 250000));
  await Promise.resolve();
  const started = fixture.pending.length;
  for (const resolve of fixture.pending) resolve();
  await Promise.all(pending);
  expect(started).toBeLessThanOrEqual(2);
});

it("holds a native-work slot after cancellation until the decoder actually settles", async () => {
  const { ImageTransformBudget } = await import("../apps/mcp-server/src/image-transform-budget.ts");
  const budget = new ImageTransformBudget(1);
  const abort = new AbortController();
  const image = { type: "image", data: "x".repeat(400000), mimeType: "image/png" };
  const first = deliverImages([image], {}, 250000, abort.signal, budget);
  expect(budget.stats().active).toBe(1);
  abort.abort();
  expect((await first).content.filter(item => item.type === "image")).toHaveLength(0);
  expect(budget.stats().active).toBe(1);
  const busy = await deliverImages([image], {}, 250000, undefined, budget);
  expect(busy.structuredContent.imageDelivery[0]).toMatchObject({ captured: true, delivered: false, reason: "image_delivery_busy" });
  expect(fixture.pending).toHaveLength(1);
  const small = await deliverImages([{ ...image, data: "AAAA" }], {}, 250000, undefined, budget);
  expect(small.content.some(item => item.type === "image")).toBe(true);
  fixture.pending.shift()!();
  await Promise.resolve();
  expect(budget.stats().active).toBe(0);
  const next = deliverImages([image], {}, 250000, undefined, budget);
  fixture.pending.shift()!();
  expect((await next).content.some(item => item.type === "image")).toBe(true);
  expect(budget.stats()).toMatchObject({ active: 0, highWater: 1, refused: 1, completed: 2 });
});

it("measures JSON escapes and UTF-8 exactly without serializing the complete value", async () => {
  const { jsonBytes } = await import("../apps/mcp-server/src/json-budget.ts");
  const values = [
    { text: 'șță 🚀 "\n\\\u0000', lone: "\ud800\udfff\ud800x\udfff", omitted: undefined },
    [null, false, true, -0, NaN, Infinity, 1e-7, 1e21, undefined, , "é\u2028"],
    { "0": 42, deep: [{ long: "🚀".repeat(5000) }], ignored: () => 1 },
    Object.assign(Object.create(null), { text: "synthetic" }),
  ];
  for (const value of values) {
    const expected = Buffer.byteLength(JSON.stringify(value));
    expect(jsonBytes(value, expected)).toBe(expected);
    expect(() => jsonBytes(value, expected - 1)).toThrow(/budget/);
  }
});

it("bounds malformed receipt inspection and never executes an accessor or custom serializer", () => {
  const store = new ResultRecoveryStore(2, 1, 8192);
  const getter = vi.fn(() => "x".repeat(1000000));
  const custom = vi.fn(() => ({ secret: "synthetic" }));
  for (const value of [Object.defineProperty({ invalid: 1n }, "data", { enumerable: true, get: getter }), { toJSON: custom }]) {
    const slot = store.begin();
    store.finish(slot.id, value);
    const page = store.read(slot.id) as { state: string; data: string };
    expect(page.state).toBe("complete");
    expect(JSON.parse(Buffer.from(page.data, "base64").toString())).toHaveProperty("serializationFailed", true);
  }
  expect(getter).not.toHaveBeenCalled();
  expect(custom).not.toHaveBeenCalled();
  expect(store.stats().retainedBytes).toBeLessThanOrEqual(store.maxBytes);
});

it("bounds deeply nested recovery receipts before native serialization", () => {
  const store = new ResultRecoveryStore();
  let value: unknown = null;
  for (let i = 0; i < 200; i++) value = { next: value };
  const slot = store.begin();
  expect(store.finish(slot.id, value).payloadAvailable).toBe(false);
  const page = store.read(slot.id) as { data: string };
  expect(JSON.parse(Buffer.from(page.data, "base64").toString())).toMatchObject({
    receiptUnavailable: true, serializationLimit: "depth", preflight: true, noReplay: true,
  });
});
