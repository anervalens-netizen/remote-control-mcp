import sharp, { type OutputInfo } from "sharp";
import { jsonBytes as bytes } from "./json-budget.ts";
import { imageTransforms, type ImageTransformBudget } from "./image-transform-budget.ts";

type Image = { type: "image"; data: string; mimeType: string };
/** Original retention is reported by result recovery. Only delivery is
 * transformed; snapshot coordinates always remain in the original pixel space. */
export async function deliverImages(content: unknown[], structured: Record<string, unknown>, limit: number, signal?: AbortSignal, budget: ImageTransformBudget = imageTransforms) {
  const deadline = performance.now() + 5000;
  const originals = content.filter((item): item is Image => !!item && typeof item === "object" && (item as Image).type === "image");
  const images: Image[] = [];
  const deliveredIndices = new Map<number, number>();
  const delivery: Record<string, unknown>[] = [];
  const final = { ...structured, imageDelivery: delivery, ...(originals.length > 4 ? { imageDeliveryOmitted: originals.length - 4 } : {}) };
  const output = () => ({ content: [{ type: "text" as const, text: JSON.stringify(final) }, ...images], structuredContent: final });
  for (const [index, image] of originals.slice(0, 4).entries()) {
    const row: Record<string, unknown> = { index, captured: true, delivered: false, transformed: false, originalMimeType: image.mimeType };
    delivery.push(row);
    let release: (() => void) | undefined;
    let nativePending = false, exited = false;
    const settled = () => { nativePending = false; if (exited) release?.(); };
    try {
      if (signal?.aborted || performance.now() >= deadline) throw new Error("image_delivery_deadline");
      if (image.data.length > 32 * 1024 * 1024) throw new Error("image_delivery_input_limit");
      row.originalBytes = Buffer.byteLength(image.data, "base64");
      const remaining = Math.max(0, limit - bytes(output()) - 2048);
      if (bytes(image) <= remaining) {
        deliveredIndices.set(index, images.length);
        images.push(image);
        Object.assign(row, { delivered: true, deliveredBytes: row.originalBytes, mimeType: image.mimeType });
        continue;
      }
      release = budget.acquire();
      if (!release) { row.reason = "image_delivery_busy"; continue; }
      const input = Buffer.from(image.data, "base64");
      row.originalBytes = input.length;
      // Fixed attempts bound work. Decode limits and timeout also apply to
      // malformed/high-compression input. Never truncate encoded image bytes.
      let selected: Image | undefined;
      for (const size of [1600, 1200, 800, 480]) {
        const remainingMs = deadline - performance.now();
        if (signal?.aborted || remainingMs <= 0) throw new Error("image_delivery_deadline");
        const pipeline = sharp(input, { limitInputPixels: 32 * 1024 * 1024, failOn: "warning" })
          .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 75, chromaSubsampling: "4:4:4" }).timeout({ seconds: Math.max(1, Math.ceil(remainingMs / 1000)) });
        const native = pipeline.toBuffer({ resolveWithObject: true });
        nativePending = true;
        // destroy() requests cancellation; only the native promise proves that
        // work settled. Keep its slot pinned after a caller timeout/abort.
        void native.then(settled, settled);
        const encoded = await new Promise<{ data: Buffer; info: OutputInfo }>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            pipeline.destroy();
            reject(new Error("image_delivery_deadline"));
          };
          const timer = setTimeout(stop, remainingMs);
          signal?.addEventListener("abort", stop, { once: true });
          void native.then(resolve, reject).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
          });
          if (signal?.aborted) stop();
        });
        const candidate: Image = { type: "image", data: encoded.data.toString("base64"), mimeType: "image/jpeg" };
        if (bytes(candidate) <= remaining) {
          selected = candidate;
          Object.assign(row, { delivered: true, transformed: true, deliveredBytes: encoded.data.length,
            mimeType: candidate.mimeType, width: encoded.info.width, height: encoded.info.height,
            coordinateSpace: "original_snapshot", original: structured.resultRecovery && (structured.resultRecovery as { payloadAvailable?: boolean }).payloadAvailable !== false ? "resultRecovery" : "unavailable" });
          break;
        }
      }
      if (selected) { deliveredIndices.set(index, images.length); images.push(selected); }
      else row.reason = "image_delivery_budget";
    } catch { row.reason = "image_delivery_failed"; }
    finally { exited = true; if (!nativePending) release?.(); }
  }
  // available describes this delivered response, captured describes the original.
  // Do not mutate the retained receipt.
  function mark(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(mark);
    if (!value || typeof value !== "object") return value;
    const mapped = { ...value } as Record<string, unknown>;
    if (typeof mapped.imageIndex === "number") {
      const delivered = deliveredIndices.get(mapped.imageIndex);
      if (delivered === undefined) { delete mapped.imageIndex; mapped.imageDelivered = false; }
      else { mapped.imageIndex = delivered; mapped.imageDelivered = true; }
    }
    return Object.fromEntries(Object.entries(mapped).map(([key, item]) => [
      key, key === "image" && originals.length === 1 && item && typeof item === "object" && (item as any).available === true
        ? { ...item, captured: true, delivered: images.length > 0, available: images.length > 0,
          ...(images.length === 0 ? { reason: "image_delivery_failed" } : {}) }
        : mark(item),
    ]));
  }
  Object.assign(final, mark(final));
  return output();
}
