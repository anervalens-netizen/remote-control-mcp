import { expect, it } from "vitest";
import { BROWSER_RECEIPT_MAX_BYTES, retainBrowserReceipt } from "../apps/agent/src/browser-receipt-retention.ts";
import { browserActionResultSchema, type BrowserActionResult } from "../packages/protocol/src/browser.ts";

function receipt(): BrowserActionResult {
  return { sessionId: "test-session", executionId: "test-execution", ok: true, executed: 1,
    results: [{ index: 0, action: "evaluate", ok: true, result: { value: 1 } }], pages: [],
    status: "completed", activeStepIndex: null, outcome: "settled" };
}
it("preserves small completed-step evidence as an independent history snapshot", () => {
  const original = receipt(); const retained = retainBrowserReceipt(original);
  expect(retained.results[0]?.result).toEqual({ value: 1 });
  original.results[0]!.result = { value: 2 };
  expect(retained.results[0]?.result).toEqual({ value: 1 });
  expect(browserActionResultSchema.safeParse(retained).success).toBe(true);
});
it("bounds both giant payloads and the whole retained envelope without clipping the actual response", () => {
  const original = receipt();
  const huge = "x".repeat(2 * 1024 * 1024);
  original.results = Array.from({ length: 1000 }, (_, index) => ({ index, action: "evaluate", ok: true, result: { value: huge } }));
  original.executed = original.results.length;
  original.pages = Array.from({ length: 100 }, (_, index) => ({ pageId: String(index), url: huge }));
  const retained = retainBrowserReceipt(original);
  expect(Buffer.byteLength(JSON.stringify(retained))).toBeLessThanOrEqual(BROWSER_RECEIPT_MAX_BYTES);
  expect(retained).toMatchObject({ receiptSummary: true, retentionTruncated: true, executed: 1000 });
  expect(retained.results[0]?.result).toMatchObject({ payloadRetained: false });
  expect(original.results[0]?.result).toEqual({ value: huge });
  expect(original.results).toHaveLength(1000);
  expect(browserActionResultSchema.safeParse(retained).success).toBe(true);
});
