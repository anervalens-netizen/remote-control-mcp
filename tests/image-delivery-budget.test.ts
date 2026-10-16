import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ destroy: vi.fn(), attempts: vi.fn() }));
vi.mock("sharp", () => ({ default: () => {
  const pipeline = {
    resize: () => pipeline, jpeg: () => pipeline, timeout: () => pipeline,
    destroy: fixture.destroy,
    toBuffer: () => { fixture.attempts(); return new Promise(() => {}); },
  };
  return pipeline;
} }));
import { deliverImages } from "../apps/mcp-server/src/image-delivery.ts";
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it.each([false, true])("bounds all image conversion work and aborts the active pipeline (cancel=%s)", async cancel => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const controller = new AbortController();
  const images = Array.from({ length: 4 }, () => ({ type: "image", data: "x".repeat(400000), mimeType: "image/png" }));
  const result = deliverImages(images, {}, 250000, controller.signal);
  if (cancel) controller.abort();
  else await vi.advanceTimersByTimeAsync(5000);
  expect((await result).content.filter(item => item.type === "image")).toHaveLength(0);
  expect(fixture.attempts).toHaveBeenCalledTimes(1);
  expect(fixture.destroy).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
