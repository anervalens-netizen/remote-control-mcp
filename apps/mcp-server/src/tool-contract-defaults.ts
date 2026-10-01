import { startToolProgress, toolOutcome, type ToolDiagnostics } from "./tool-diagnostics.ts";
import { withErrorOutputContract } from "./error-output-contract.ts";
import { withToolErrors } from "./tool-errors.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolResultSchemas, type ToolResultName } from "./semantic-result-schemas.ts";

const installedServers = new WeakSet<object>();

// Hints describe effects; they never authorize or restrict the owner. Do not
// infer read-only from a name: mixed/action tools deliberately have no default.
const readOnlyTools = new Set([
  "devices_list", "device_info", "device_contexts", "fs_read", "fs_list", "batch_read",
  "job_status", "job_output", "job_output_since", "job_wait", "job_list", "job_history", "job_lineage",
  "pty_output", "search_results", "search_status", "service_inspect", "service_logs",
  "network_snapshot", "android_status",
]);

export const STRUCTURED_CONTENT_MAX_BYTES = 64 * 1024;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clipString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  const clipped = buffer.subarray(0, Math.max(0, maxBytes - 96)).toString("utf8");
  return `${clipped}… [structuredContent clipped; full value retained in content]`;
}

type CompactBudget = { stringBytes: number; arrayItems: number; objectEntries: number };
type SafeParseSchema = { safeParse(value: unknown): { success: boolean } };
const SMALL_OBJECT_ENTRIES = 32;

function compactValue(value: unknown, budget: CompactBudget, depth = 0): unknown {
  if (typeof value === "string") return clipString(value, budget.stringBytes);
  if (Array.isArray(value)) {
    return value.slice(0, budget.arrayItems).map((item) => compactValue(item, budget, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  // Preserve every top-level contract field and every small nested object.
  // Registered semantic envelopes use small objects for required fields
  // (for example {index, action, ok, result}); wide nested objects are the
  // dynamic payloads that actually need bounding.
  const selected = depth === 0 || entries.length <= SMALL_OBJECT_ENTRIES
    ? entries
    : entries.slice(0, budget.objectEntries);
  return Object.fromEntries(selected.map(([key, item]) => [key, compactValue(item, budget, depth + 1)]));
}

function truncatedEnvelope(
  compacted: Record<string, unknown>,
  originalBytes: number,
  maxBytes: number,
): Record<string, unknown> {
  return {
    ...compacted,
    structuredContentTruncated: true,
    structuredContentOriginalBytes: originalBytes,
    structuredContentLimitBytes: maxBytes,
    structuredContentNotice: "Large values/items are clipped only in structuredContent; the complete legacy JSON remains in content.",
  };
}

export function compactStructuredContent(
  value: Record<string, unknown>,
  maxBytes = STRUCTURED_CONTENT_MAX_BYTES,
  schema?: SafeParseSchema,
): Record<string, unknown> {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= maxBytes) return value;

  const budgets: CompactBudget[] = [
    { stringBytes: 4096, arrayItems: 64, objectEntries: 64 },
    { stringBytes: 1024, arrayItems: 16, objectEntries: 16 },
    { stringBytes: 256, arrayItems: 4, objectEntries: 4 },
    { stringBytes: 64, arrayItems: 1, objectEntries: 1 },
    { stringBytes: 0, arrayItems: 0, objectEntries: 0 },
  ];
  for (const budget of budgets) {
    const candidate = truncatedEnvelope(
      compactValue(value, budget) as Record<string, unknown>,
      originalBytes,
      maxBytes,
    );
    if (jsonBytes(candidate) <= maxBytes && (!schema || schema.safeParse(candidate).success)) return candidate;
  }

  // A pathological result can have more top-level key bytes than the entire
  // budget. In that case prefer a bounded truthful envelope over violating the
  // transport contract; normal registered tool shapes never need this fallback.
  const fallback = {
    structuredContentTruncated: true,
    structuredContentOriginalBytes: originalBytes,
    structuredContentLimitBytes: maxBytes,
    structuredContentNotice: "Structured content omitted because even its top-level shape exceeds the configured budget; full legacy JSON remains in content.",
  };
  if (jsonBytes(fallback) <= maxBytes) return fallback;
  return { structuredContentTruncated: true };
}

/** Compact pages by whole items and advance from the last actually delivered row. */
export function compactHistoryPage(value: Record<string, unknown>, maxBytes = STRUCTURED_CONTENT_MAX_BYTES): Record<string, unknown> {
  if (jsonBytes(value) <= maxBytes) return value;
  if (!Array.isArray(value.items)) throw new Error("Invalid job history page");
  const items = value.items as Array<Record<string, unknown>>;
  let low = 1; let high = items.length; let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const last = items[count - 1]!;
    const nextCursor = count < items.length
      ? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url")
      : value.nextCursor;
    const candidate = truncatedEnvelope({ ...value, items: items.slice(0, count), nextCursor }, jsonBytes(value), maxBytes);
    candidate.structuredContentNotice = "Page shortened at a whole-item boundary; nextCursor resumes after the last delivered item. Full legacy page remains in content.";
    if (jsonBytes(candidate) <= maxBytes) { best = candidate; low = count + 1; }
    else high = count - 1;
  }
  if (!best) throw new Error("A job history item exceeds the structured output budget; use job_status for that receipt. No pagination cursor was advanced.");
  return best;
}

export function structuredFromContent(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) return { result: content };
  const types = [...new Set(content.map((item: any) => typeof item?.type === "string" ? item.type : "unknown"))];
  const textParts = content.filter((item: any) => item?.type === "text" && typeof item.text === "string");
  if (textParts.length === 1) {
    const value = textParts[0]!.text as string;
    try {
      const parsed = JSON.parse(value);
      const contentTypes = types.some((type) => type !== "text") ? { contentTypes: types } : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...(parsed as Record<string, unknown>), ...contentTypes };
      if (Array.isArray(parsed)) return { items: parsed, ...contentTypes };
      return { result: parsed, ...contentTypes };
    } catch {
      // Plain human-readable text remains text. Do not copy image/resource
      // payloads into structuredContent.
      return { text: value, ...(types.some((type) => type !== "text") ? { contentTypes: types } : {}) };
    }
  }
  return { contentTypes: types };
}

/** Install semantic output contracts and bound duplicated structured payloads once per MCP server. */
export function installDefaultToolOutputContracts(server: McpServer, diagnostics?: ToolDiagnostics): void {
  if (installedServers.has(server)) return;
  const target = server as any;
  const original = target.registerTool.bind(server);
  target.registerTool = (name: string, config: any, callback: (...args: any[]) => any) => {
    const schema = config?.outputSchema ?? toolResultSchemas[name as ToolResultName];
    if (!schema) throw new Error(`Missing semantic output contract for registered tool: ${name}`);
    const advertisedSchema = withErrorOutputContract(schema);
    const wrappedCallback = async (...args: any[]) => {
      const started = performance.now();
      const extra = args[1];
      const stopProgress = startToolProgress(name, extra);
      let outcome: ReturnType<typeof toolOutcome> = "error";
      try {
        const result = await withToolErrors(() => callback(...args));
        if (!result || typeof result !== "object") return result;
        const current = (result as any).structuredContent;
        const structured = current && typeof current === "object" && !Array.isArray(current)
          ? current as Record<string, unknown>
          : structuredFromContent((result as any).content);
        outcome = toolOutcome(result, structured, extra?.signal);
        if (name === "job_history" && !(result as any).isError) {
          try { return { ...result, structuredContent: compactHistoryPage(structured) }; }
          catch (error) { outcome = "error"; return withToolErrors(() => { throw error; }); }
        }
        return { ...result, structuredContent: compactStructuredContent(structured, STRUCTURED_CONTENT_MAX_BYTES, advertisedSchema) };
      } finally {
        stopProgress();
        diagnostics?.record(name, args[0], performance.now() - started, outcome);
      }
    };
    const annotations = readOnlyTools.has(name)
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...config?.annotations }
      : config?.annotations;
    return original(name, { ...config, ...(annotations ? { annotations } : {}), outputSchema: advertisedSchema }, wrappedCallback);
  };
  installedServers.add(server);
}
