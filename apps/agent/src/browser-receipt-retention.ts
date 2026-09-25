import type { BrowserActionResult } from "../../../packages/protocol/src/browser.ts";

export const BROWSER_RECEIPT_MAX_BYTES = 32 * 1024;
const MAX_RESULTS = 32;
const MAX_PAGES = 8;

// Stop before serializing or cloning a large page result. This conservative
// JSON-size estimate deliberately rejects unusual objects and deep payloads.
function smallPayload(value: unknown): boolean {
  let remaining = 1024;
  let nodes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 64 || depth > 6 || remaining < 0) return false;
    if (item === null || item === undefined || typeof item === "boolean") { remaining -= 6; return remaining >= 0; }
    if (typeof item === "number") { remaining -= 32; return remaining >= 0; }
    if (typeof item === "string") { remaining -= item.length * 6 + 2; return remaining >= 0; }
    if (typeof item !== "object") return false;
    if (Array.isArray(item) && item.length > 64) return false;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    remaining -= 2;
    for (const key in item) {
      if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !("value" in property)) return false;
      remaining -= key.length * 6 + 4;
      if (remaining < 0 || !visit(property.value, depth + 1)) return false;
    }
    return remaining >= 0;
  };
  return visit(value, 0);
}

export function retainBrowserReceipt(receipt: BrowserActionResult): BrowserActionResult {
  let clipped = receipt.results.length > MAX_RESULTS || receipt.pages.length > MAX_PAGES;
  const text = (value: string | undefined, limit: number): string | undefined => {
    if (value === undefined || value.length <= limit) return value;
    clipped = true;
    return value.slice(0, limit) + " [receipt text clipped]";
  };
  const results = receipt.results.slice(0, MAX_RESULTS).map(({ result, error, ...step }) => {
    const retained = { ...step, ...(error === undefined ? {} : { error: text(error, 256) }) };
    if (result === undefined) return retained;
    if (smallPayload(result)) return { ...retained, result: structuredClone(result) };
    clipped = true;
    return { ...retained, result: { payloadRetained: false, reason: "receipt_summary_budget" } };
  });
  const retained = {
    ...receipt,
    ...(receipt.error === undefined ? {} : { error: text(receipt.error, 512) }),
    results,
    pages: receipt.pages.slice(0, MAX_PAGES).map(page => ({ ...page, url: text(page.url, 512)! })),
    receiptSummary: true,
    retentionTruncated: clipped,
    retentionLimitBytes: BROWSER_RECEIPT_MAX_BYTES,
  };
  // Check the serialized envelope, not only individual values. The immediate
  // operation result remains untouched; only recoverable history is compacted.
  const bytes = () => Buffer.byteLength(JSON.stringify(retained), "utf8");
  for (let index = results.length - 1; bytes() > BROWSER_RECEIPT_MAX_BYTES && index >= 0; index--) {
    const item = results[index]!;
    if ("result" in item) item.result = { payloadRetained: false, reason: "receipt_envelope_budget" };
    retained.retentionTruncated = true;
  }
  while (bytes() > BROWSER_RECEIPT_MAX_BYTES && retained.results.length) {
    retained.results.pop(); retained.retentionTruncated = true;
  }
  return retained;
}
