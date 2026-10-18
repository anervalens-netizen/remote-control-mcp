import { jsonBytes, JsonBudgetError } from "./json-budget.ts";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const recoveryReferenceSchema = z.object({
  id: z.string(), tool: z.literal("result_recover"), expiresAt: z.string(),
  scope: z.literal("controller_memory"), noReplay: z.literal(true), payloadAvailable: z.boolean().optional(),
});
const invocationSchema = z.object({ tool: z.string(), requestId: z.union([z.string(), z.number()]).optional(), requestIdHash: z.string().optional(), sessionIdHash: z.string().optional() });
type Invocation = z.infer<typeof invocationSchema>;
export const resultMetadataFields = {
  imageDeliveryOmitted: z.number().int().nonnegative().optional(),
  imageDelivery: z.array(z.record(z.string(), z.unknown())).max(4).optional(),
  observationCoverage: z.record(z.string(), z.unknown()).optional(),
  operationTrace: z.object({ traceId: z.string().uuid(), controllerInstanceId: z.string().uuid() }).optional(),
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
  readonly maxEntries: number;
  readonly controlEntries: number;
  readonly maxBytes: number;
  constructor(maxEntries = 64, controlEntries = 8, maxBytes = 64 * 1024 * 1024) { this.maxEntries = maxEntries; this.controlEntries = controlEntries; if (!Number.isSafeInteger(maxBytes) || maxBytes < (maxEntries + controlEntries) * 512) throw new Error("Invalid recovery byte budget"); this.maxBytes = maxBytes; }
  private serializationRefused = 0;
  private entries = new Map<string, { expires: number; state: "reserved" | "running" | "complete"; data?: Buffer; invocation?: Invocation; control: boolean; payloadUnavailable?: boolean }>();
  private sweep() {
    for (const [id, entry] of this.entries) if (entry.state !== "running" && entry.expires <= Date.now()) this.entries.delete(id);
  }
  prepare(control = false) {
    this.sweep();
    const count = () => [...this.entries.values()].filter(e => e.control === control).length;
    const limit = control ? this.controlEntries : this.maxEntries;
    if (count() >= limit) {
      // Evict only completed receipts, oldest first. Reserved/active slots are
      // pinned, so admission failure always happens before effects.
      const oldest = [...this.entries].filter(([, entry]) => entry.state === "complete" && entry.control === control).sort((a, b) => a[1].expires - b[1].expires)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    if (count() >= limit) throw new Error("Result recovery admission full; No dispatch occurred. result_recover and result_recovery_release remain available; inspect existing work before retrying.");
    const id = randomUUID();
    this.entries.set(id, { expires: Date.now() + this.retentionMs, state: "reserved", control });
    return this.reference(id);
  }
  begin(id?: string, invocation?: { tool: string; requestId?: string | number; sessionId?: string }, control = false) {
    const reference = id === undefined ? this.prepare(control) : this.reference(id);
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
    return { id, tool: "result_recover" as const, expiresAt: new Date(entry.expires).toISOString(), scope: "controller_memory" as const, noReplay: true as const, ...(entry.payloadUnavailable === true ? { payloadAvailable: false } : {}) };
  }
  finish(id: string, value: unknown) {
    const entry = this.entries.get(id)!;
    // Preflight bounds the string/Buffer copies before JSON.stringify allocates.
    // Serialization is synchronous: only one such copy is prepared at a time.
    const serializationLimit = this.maxBytes - (this.maxEntries + this.controlEntries) * 512;
    const unavailable = (reason: string, limit?: string) => {
      this.serializationRefused++;
      entry.payloadUnavailable = true;
      return Buffer.from(JSON.stringify({ receiptUnavailable: true, reason, noReplay: true,
        ...(limit ? { serializationLimit: limit, preflight: true } : {}),
        notice: "Inspect durable job/output receipts; missing payload never authorizes replay." }));
    };
    try {
      jsonBytes(value, serializationLimit);
      entry.data = Buffer.from(JSON.stringify(value));
    } catch (error) {
      if (error instanceof JsonBudgetError) {
        entry.data = unavailable(error.limit === "bytes" ? "recovery_byte_budget" : "recovery_serialization_budget", error.limit);
      } else {
        // Malformed callbacks receive a bounded, explicitly non-exact inspection.
        try {
          const inspection = { serializationFailed: true, inspection: inspectNonJson(value) };
          jsonBytes(inspection, serializationLimit);
          entry.data = Buffer.from(JSON.stringify(inspection));
        } catch { entry.data = unavailable("recovery_inspection_budget"); }
      }
    }
    // Retain the no-replay reservation even when payload bytes are shed.
    // Small explicit tombstones replace bytes; never represent them as originals.
    const shed = (target: typeof entry) => {
      const originalBytes = target.data?.length ?? 0;
      target.payloadUnavailable = true;
      target.data = Buffer.from(JSON.stringify({ receiptUnavailable: true, reason: "recovery_byte_budget",
        originalBytes, noReplay: true, notice: "Inspect durable job/output receipts; missing payload never authorizes replay." }));
    };
    if (entry.data.length > this.maxBytes - (this.maxEntries + this.controlEntries) * 512) shed(entry);
    const total = () => [...this.entries.values()].reduce((sum, row) => sum + (row.data?.length ?? 0), 0);
    for (const [, candidate] of [...this.entries].sort((a, b) => a[1].expires - b[1].expires)) {
      if (total() <= this.maxBytes) break;
      if (candidate !== entry && candidate.state === "complete" && (candidate.data?.length ?? 0) > 512) shed(candidate);
    }
    if (total() > this.maxBytes) shed(entry);
    entry.state = "complete";
    entry.expires = Date.now() + this.retentionMs;
    return this.reference(id);
  }
  stats() {
    this.sweep();
    const rows = [...this.entries.values()];
    return { slots: rows.length, normalLimit: this.maxEntries, controlLimit: this.controlEntries,
      controlSlots: rows.filter(e => e.control).length, running: rows.filter(e => e.state === "running").length,
      maxBytes: this.maxBytes,
      maxSerializationBytes: this.maxBytes - (this.maxEntries + this.controlEntries) * 512,
      serializationRefused: this.serializationRefused,
      retainedBytes: rows.reduce((sum,e) => sum + (e.data?.length ?? 0), 0),
      largestReceiptBytes: Math.max(0, ...rows.map(e => e.data?.length ?? 0)),
      scope: "controller_memory", memoryAccounting: "Retained buffers only. Preflight bounds temporary JSON copies; input objects and native image allocations are separate." };
  }
  failIfRunning(id: string) {
    if (this.entries.get(id)?.state === "running") this.finish(id, { resultPreparationFailed: true, noReplay: true,
      notice: "The handler may have executed; no valid callback receipt could be serialized. Inspect agent effects." });
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
    description: "Reserve a controller-memory result ID before dispatch. Pass its id as the top-level resultRecoveryId tool argument (legacy tools/call _meta.resultRecoveryId is also accepted). One use only; survives session reconnect but not controller restart. Retained up to 15 minutes or 64 newer results; active/reserved slots are pinned. Use durable jobs for restart/crash recovery.",
    inputSchema: {}, outputSchema: recoveryReferenceSchema,
  }, async () => text(store.prepare()));
  server.registerTool("result_recover", {
    description: "Omit id to list up to 72 retained receipt IDs and request correlation (no arguments/output). Specify id to read the original pre-compaction JSON without execution. Base64 pages, byte offsets. Same authenticated controller; up to 15 minutes with bounded normal/control capacity. Missing/expired never authorizes replay.",
    annotations: { readOnlyHint: true },
    inputSchema: { id: z.string().uuid().optional(), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(1).max(12 * 1024).optional() }, outputSchema: output,
  }, async ({ id, offset, length }) => text(id === undefined ? store.list() : store.read(id, offset, length)));
  server.registerTool("result_recovery_release", {
    description: "Release a completed/reserved memory result after reading it. This never reauthorizes the ID for dispatch.",
    inputSchema: { id: z.string().uuid() }, outputSchema: z.object({ released: z.literal(true), noReplay: z.literal(true) }),
  }, async ({ id }) => text(store.release(id)));
}

function inspectNonJson(value: unknown, seen = new WeakSet<object>(), depth = 0, budget = { nodes: 512 }): unknown {
  if (--budget.nodes < 0 || depth >= 16) return { nonJsonType: "inspection_limit" };
  if (typeof value === "string" && value.length > 1024) return { nonJsonType: "string_preview", text: value.slice(0, 1024), originalCodeUnits: value.length };
  if (typeof value === "bigint") {
    const max = (1n << 4096n) - 1n;
    return value > max || value < -max ? { nonJsonType: "bigint", decimalOmitted: true } : { nonJsonType: "bigint", decimal: String(value) };
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return { nonJsonType: typeof value };
  if (typeof value === "number" && !Number.isFinite(value)) return { nonJsonType: "number", value: String(value) };
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return { nonJsonType: "circular_reference" };
  seen.add(value);
  const field = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor ? { nonJsonType: "undefined" } : "value" in descriptor
      ? inspectNonJson(descriptor.value, seen, depth + 1, budget) : { nonJsonType: "accessor" };
  };
  let result: unknown;
  if (Array.isArray(value)) {
    const items = Array.from({ length: Math.min(value.length, 32) }, (_, i) => field(String(i)));
    result = value.length > 32 ? { nonJsonType: "array_preview", items, originalLength: value.length } : items;
  } else {
    const mapped: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ >= 32 || budget.nodes <= 0) { mapped.inspectionOmitted = true; break; }
      mapped[key.slice(0, 1024)] = field(key);
    }
    result = mapped;
  }
  seen.delete(value);
  return result;
}

const stores = new WeakMap<object, ResultRecoveryStore>();
export function recoveryFor(owner: object) {
  let store = stores.get(owner);
  if (!store) { store = new ResultRecoveryStore(); stores.set(owner, store); }
  return store;
}
