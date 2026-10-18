/** Count JSON-shaped receipts without allocating their serialized copy.
 * Accessors/custom serializers are not wire data and must not run in preflight. */
export class JsonBudgetError extends Error {
  readonly limit: "bytes" | "nodes" | "depth";
  constructor(limit: "bytes" | "nodes" | "depth") {
    super("JSON preparation budget exceeded: " + limit);
    this.limit = limit;
  }
}
export const JSON_MEASUREMENT_LIMIT = 256 * 1024 * 1024;
export function jsonBytes(value: unknown, maxBytes = JSON_MEASUREMENT_LIMIT): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > JSON_MEASUREMENT_LIMIT) throw new RangeError("Invalid JSON measurement budget");
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  function add(count: number) {
    bytes += count;
    if (bytes > maxBytes) throw new JsonBudgetError("bytes");
  }
  function string(value: string) {
    add(Buffer.byteLength(value, "utf8") + 2);
    // UTF-8 size is computed natively. Add only JSON escape expansion; valid
    // surrogate pairs stay UTF-8, while lone surrogates become six-byte escapes.
    const escapes = /["\\\u0000-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
    for (const match of value.matchAll(escapes)) {
      const c = match[0]!.charCodeAt(0);
      add(c >= 0xd800 && c <= 0xdfff ? 3
        : c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 1 : 5);
    }
  }
  function read(object: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) throw new TypeError("JSON receipt contains an accessor");
    return descriptor.value;
  }
  const omitted = (v: unknown) => v === undefined || typeof v === "function" || typeof v === "symbol";
  function visit(v: unknown, depth: number) {
    if (++nodes > 1_000_000) throw new JsonBudgetError("nodes");
    if (depth > 128) throw new JsonBudgetError("depth");
    if (v === null || omitted(v)) { add(4); return; }
    if (typeof v === "string") { string(v); return; }
    if (typeof v === "boolean") { add(v ? 4 : 5); return; }
    if (typeof v === "number") { add(Number.isFinite(v) ? String(v).length : 4); return; }
    if (typeof v !== "object") throw new TypeError("Non-JSON receipt value");
    const prototype = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null) throw new TypeError("Non-JSON receipt prototype");
    if ("toJSON" in v && (typeof read(v, "toJSON") === "function" || !Object.hasOwn(v, "toJSON"))) throw new TypeError("Custom JSON serializers are not receipt data");
    if (ancestors.has(v)) throw new TypeError("Circular JSON receipt");
    ancestors.add(v);
    add(2);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { if (i) add(1); visit(read(v, String(i)), depth + 1); }
    } else {
      let count = 0;
      for (const key in v) {
        if (!Object.hasOwn(v, key)) continue;
        if (++nodes > 1_000_000) throw new JsonBudgetError("nodes");
        const item = read(v, key);
        if (omitted(item)) continue;
        if (count++) add(1);
        string(key); add(1); visit(item, depth + 1);
      }
    }
    ancestors.delete(v);
  }
  if (omitted(value)) throw new TypeError("Missing JSON receipt");
  visit(value, 0);
  return bytes;
}
