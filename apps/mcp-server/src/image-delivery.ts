import sharp from "sharp";

type Image = { type: "image"; data: string; mimeType: string };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Original content is already retained by result recovery. Only delivery is
 * transformed; snapshot coordinates always remain in the original pixel space. */
export async function deliverImages(content: unknown[], structured: Record<string, unknown>, limit: number) {
  const originals = content.filter((item): item is Image => !!item && typeof item === "object" && (item as Image).type === "image");
  const images: Image[] = [];
  const delivery: Record<string, unknown>[] = [];
  const final = { ...structured, imageDelivery: delivery, ...(originals.length > 4 ? { imageDeliveryOmitted: originals.length - 4 } : {}) };
  const output = () => ({ content: [{ type: "text" as const, text: JSON.stringify(final) }, ...images], structuredContent: final });
  for (const [index, image] of originals.slice(0, 4).entries()) {
    const row: Record<string, unknown> = { index, captured: true, delivered: false, transformed: false, originalMimeType: image.mimeType };
    delivery.push(row);
    try {
      if (index >= 4 || image.data.length > 32 * 1024 * 1024) throw new Error("image_delivery_input_limit");
      const input = Buffer.from(image.data, "base64");
      row.originalBytes = input.length;
      const remaining = Math.max(0, limit - bytes(output()) - 2048);
      if (bytes(image) <= remaining) {
        images.push(image);
        Object.assign(row, { delivered: true, deliveredBytes: input.length, mimeType: image.mimeType });
        continue;
      }
      // Fixed attempts bound work. Decode limits and timeout also apply to
      // malformed/high-compression input. Never truncate encoded image bytes.
      let selected: Image | undefined;
      for (const size of [1600, 1200, 800, 480]) {
        const encoded = await sharp(input, { limitInputPixels: 32 * 1024 * 1024, failOn: "warning" })
          .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 75, chromaSubsampling: "4:4:4" }).timeout({ seconds: 5 })
          .toBuffer({ resolveWithObject: true });
        const candidate: Image = { type: "image", data: encoded.data.toString("base64"), mimeType: "image/jpeg" };
        if (bytes(candidate) <= remaining) {
          selected = candidate;
          Object.assign(row, { delivered: true, transformed: true, deliveredBytes: encoded.data.length,
            mimeType: candidate.mimeType, width: encoded.info.width, height: encoded.info.height,
            coordinateSpace: "original_snapshot", original: "resultRecovery" });
          break;
        }
      }
      if (selected) images.push(selected);
      else row.reason = "image_delivery_budget";
    } catch { row.reason = "image_delivery_failed"; }
  }
  // available describes this delivered response, captured describes the original.
  // Do not mutate the retained receipt.
  function mark(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(mark);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, key === "image" && item && typeof item === "object" && (item as any).available === true
        ? { ...item, captured: true, delivered: images.length > 0, available: images.length > 0,
          ...(images.length === 0 ? { reason: "image_delivery_failed" } : {}) }
        : mark(item),
    ]));
  }
  if (originals.length === 1) Object.assign(final, mark(final));
  return output();
}
