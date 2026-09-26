import { withErrorOutputContract } from "./error-output-contract.ts";
import { withToolErrors } from "./tool-errors.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolResultSchemas, type ToolResultName } from "./semantic-result-schemas.ts";

const installedServers = new WeakSet<object>();

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
export function installDefaultToolOutputContracts(server: McpServer): void {
  if (installedServers.has(server)) return;
  const target = server as any;
  const original = target.registerTool.bind(server);
  target.registerTool = (name: string, config: any, callback: (...args: any[]) => any) => {
    const schema = config?.outputSchema ?? toolResultSchemas[name as ToolResultName];
    if (!schema) throw new Error(`Missing semantic output contract for registered tool: ${name}`);
    const advertisedSchema = withErrorOutputContract(schema);
    const wrappedCallback = async (...args: any[]) => {
      const result = await withToolErrors(() => callback(...args));
      if (!result || typeof result !== "object") return result;
      const current = (result as any).structuredContent;
      const structured = current && typeof current === "object" && !Array.isArray(current)
        ? current as Record<string, unknown>
        : structuredFromContent((result as any).content);
      return { ...result, structuredContent: compactStructuredContent(structured, STRUCTURED_CONTENT_MAX_BYTES, advertisedSchema) };
    };
    return original(name, { ...config, outputSchema: advertisedSchema }, wrappedCallback);
  };
  installedServers.add(server);
}
