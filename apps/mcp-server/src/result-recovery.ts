import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const recoveryReferenceSchema = z.object({
  id: z.string(), tool: z.literal("result_recover"), expiresAt: z.string(),
  scope: z.literal("controller_memory"), noReplay: z.literal(true),
});
const invocationSchema = z.object({ tool: z.string(), requestId: z.union([z.string(), z.number()]).optional(), requestIdHash: z.string().optional(), sessionIdHash: z.string().optional() });
type Invocation = z.infer<typeof invocationSchema>;
export const resultMetadataFields = {
  resultRecovery: recoveryReferenceSchema.optional(),
  contentTruncated: z.boolean().optional(),
  contentOriginalBytes: z.number().int().nonnegative().optional(),
  totalResultLimitBytes: z.number().int().positive().optional(),
  structuredContentTruncated: z.boolean().optional(),
  structuredContentOriginalBytes: z.number().int().nonnegative().optional(),
  structuredContentLimitBytes: z.number().int().positive().optional(),
  structuredContentNotice: z.string().optional(),
};

/** Authenticated tool access only. No files, background effects, or replay API.
 * Slots are reserved before dispatch; active results are never evicted. IDs from
 * an earlier controller/expired reservation fail closed, including on reuse. */
export class ResultRecoveryStore {
  readonly retentionMs = 15 * 60 * 1000;
  readonly maxEntries = 64;
  private entries = new Map<string, { expires: number; state: "reserved" | "running" | "complete"; data?: Buffer; invocation?: Invocation }>();
  private sweep() {
    for (const [id, entry] of this.entries) if (entry.state !== "running" && entry.expires <= Date.now()) this.entries.delete(id);
  }
  prepare() {
    this.sweep();
    if (this.entries.size >= this.maxEntries) {
      // Evict only completed receipts, oldest first. Reserved/active slots are
      // pinned, so admission failure always happens before effects.
      const oldest = [...this.entries].filter(([, entry]) => entry.state === "complete").sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    if (this.entries.size >= this.maxEntries) throw new Error("Result recovery slots are full; read/release completed results or use durable jobs. No dispatch occurred.");
    const id = randomUUID();
    this.entries.set(id, { expires: Date.now() + this.retentionMs, state: "reserved" });
    return this.reference(id);
  }
  begin(id?: string, invocation?: { tool: string; requestId?: string | number; sessionId?: string }) {
    const reference = id === undefined ? this.prepare() : this.reference(id);
    const entry = this.entries.get(reference.id)!;
    if (entry.state !== "reserved") throw new Error("Recovery reservation already used; inspect result_recover. Never replay an uncertain effect.");
    entry.state = "running";
    if (invocation) {
      const { tool, requestId, sessionId } = invocation;
      const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
      entry.invocation = { tool,
        ...(typeof requestId === "number" || typeof requestId === "string" && Buffer.byteLength(JSON.stringify(requestId)) <= 200 ? { requestId } : {}),
        ...(requestId === undefined ? {} : { requestIdHash: hash(requestId) }),
        ...(sessionId === undefined ? {} : { sessionIdHash: hash(sessionId) }) };
    }
    return reference;
  }
  reference(id: string) {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Recovery unavailable or expired; absence is not permission to replay. Inspect durable job/output receipts.");
    return { id, tool: "result_recover" as const, expiresAt: new Date(entry.expires).toISOString(), scope: "controller_memory" as const, noReplay: true as const };
  }
  finish(id: string, value: unknown) {
    const entry = this.entries.get(id)!;
    // JSON is the wire contract. Keep an immutable snapshot before compaction or
    // validation, including malformed JSON-shaped receipts for inspection.
    try { entry.data = Buffer.from(JSON.stringify(value)); }
    catch {
      // A malformed in-process callback can return non-JSON values. Retain an
      // explicitly labelled inspection representation; never claim exact JSON.
      entry.data = Buffer.from(JSON.stringify({ serializationFailed: true, inspection: inspectNonJson(value) }));
    }
    entry.state = "complete";
    entry.expires = Date.now() + this.retentionMs;
    return this.reference(id);
  }
  list() {
    this.sweep();
    return { items: [...this.entries].map(([id, entry]) => ({ ...this.reference(id), state: entry.state, ...(entry.invocation ? { invocation: entry.invocation } : {}) })), total: this.entries.size };
  }
  read(id: string, offset = 0, length = 12 * 1024) {
    const reference = this.reference(id);
    const entry = this.entries.get(id)!;
    if (!entry.data) return { ...reference, state: entry.state };
    const data = entry.data.subarray(Math.min(offset, entry.data.length), Math.min(offset + length, entry.data.length));
    return { ...reference, state: entry.state, encoding: "base64", mediaType: "application/json", offset,
      bytesRead: data.length, nextOffset: offset + data.length, totalBytes: entry.data.length,
      eof: offset + data.length >= entry.data.length, data: data.toString("base64") };
  }
  release(id: string) {
    this.reference(id);
    if (this.entries.get(id)!.state === "running") throw new Error("Cannot release an active recovery reservation");
    this.entries.delete(id);
    return { released: true, noReplay: true };
  }
}

export function registerResultRecovery(server: McpServer, store: ResultRecoveryStore) {
  const waiting = recoveryReferenceSchema.extend({ state: z.enum(["reserved", "running"]) });
  const page = recoveryReferenceSchema.extend({ state: z.literal("complete"), encoding: z.literal("base64"), mediaType: z.literal("application/json"),
    offset: z.number().int().nonnegative(), bytesRead: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(), eof: z.boolean(), data: z.string() });
  const index = z.object({ items: z.array(recoveryReferenceSchema.extend({ state: z.enum(["reserved", "running", "complete"]), invocation: invocationSchema.optional() })), total: z.number().int().nonnegative() });
  const output = z.union([waiting, page, index]);
  const text = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
  server.registerTool("result_recovery_prepare", {
    description: "Reserve a controller-memory result ID before dispatch. Pass its id as tools/call _meta.resultRecoveryId. One use only; survives session reconnect but not controller restart. Retained up to 15 minutes or 64 newer results; active/reserved slots are pinned. Use durable jobs for restart/crash recovery.",
    inputSchema: {}, outputSchema: recoveryReferenceSchema,
  }, async () => text(store.prepare()));
  server.registerTool("result_recover", {
    description: "Omit id to list up to 64 retained receipt IDs and request correlation (no arguments/output). Specify id to read the original pre-compaction JSON without execution. Base64 pages, byte offsets. Same authenticated controller; up to 15 minutes or 64 newer results. Missing/expired never authorizes replay.",
    annotations: { readOnlyHint: true },
    inputSchema: { id: z.string().uuid().optional(), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(1).max(12 * 1024).optional() }, outputSchema: output,
  }, async ({ id, offset, length }) => text(id === undefined ? store.list() : store.read(id, offset, length)));
  server.registerTool("result_recovery_release", {
    description: "Release a completed/reserved memory result after reading it. This never reauthorizes the ID for dispatch.",
    inputSchema: { id: z.string().uuid() }, outputSchema: z.object({ released: z.literal(true), noReplay: z.literal(true) }),
  }, async ({ id }) => text(store.release(id)));
}

function inspectNonJson(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === "bigint") return { nonJsonType: "bigint", decimal: String(value) };
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return { nonJsonType: typeof value };
  if (typeof value === "number" && !Number.isFinite(value)) return { nonJsonType: "number", value: String(value) };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return { nonJsonType: "circular_reference" };
  if (depth >= 64) return { nonJsonType: "depth_limit" };
  seen.add(value);
  const result = Array.isArray(value) ? value.map(v => inspectNonJson(v, seen, depth + 1))
    : Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(value)).filter(([, d]) => d.enumerable).map(([key, descriptor]) => [key,
      "value" in descriptor ? inspectNonJson(descriptor.value, seen, depth + 1) : { nonJsonType: "accessor" }]));
  seen.delete(value);
  return result;
}
