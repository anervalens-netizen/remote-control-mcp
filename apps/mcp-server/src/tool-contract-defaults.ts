import { executionOutcome } from "../../../packages/protocol/src/execution-outcome.ts";
import { OperationReceiptError } from "./operation-receipt-error.ts";
import { ResultRecoveryStore, registerResultRecovery } from "./result-recovery.ts";
import { utf8Preview } from "./result-text.ts";
export { utf8Preview } from "./result-text.ts";
import { startToolProgress, toolOutcome, type ToolDiagnostics, type ResultDiagnostic } from "./tool-diagnostics.ts";
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

export const TOTAL_RESULT_MAX_BYTES = 256 * 1024;
type SafeParseSchema = { safeParse(value: unknown): { success: boolean } };

function truncatedEnvelope(value: Record<string, unknown>, originalBytes: number, maxBytes: number) {
  return { ...value, structuredContentTruncated: true, structuredContentOriginalBytes: originalBytes,
    structuredContentLimitBytes: maxBytes,
    structuredContentNotice: "Bounded preview/page; use resultRecovery for the exact original JSON receipt. Text and structured content describe the same delivered page." };
}

/** Only explicitly understood semantic fields may be shortened. Other shapes
 * use an explicit omitted-result alternative and an exact recovery reference. */
export function compactStructuredContent(value: Record<string, unknown>, maxBytes = STRUCTURED_CONTENT_MAX_BYTES, schema?: SafeParseSchema): Record<string, unknown> {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= maxBytes) return value;
  let candidate: Record<string, unknown> | undefined;
  if (value.ok === false && typeof value.error === "string") {
    candidate = truncatedEnvelope({ ...value, error: utf8Preview(value.error, 2048), errorTruncated: true }, originalBytes, maxBytes);
  } else if (Array.isArray(value.items) && Array.isArray(value.errors)) {
    const items = value.items;
    let low = 0, high = items.length;
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const page = truncatedEnvelope({ ...value, items: items.slice(0, count), totalItems: items.length, previewItems: count }, originalBytes, maxBytes);
      if (jsonBytes(page) <= maxBytes) { candidate = page; low = count + 1; }
      else high = count - 1;
    }
  } else if (typeof value.data === "string" && typeof value.nextOffset === "number") {
    const encoding = value.encoding === "base64" ? "base64" : "utf8";
    const bytes = Buffer.from(value.data, encoding);
    const data = encoding === "base64" ? bytes.subarray(0, 12 * 1024).toString("base64") : utf8Preview(value.data, 12 * 1024);
    const bytesRead = Buffer.byteLength(data, encoding);
    const offset = typeof value.offset === "number" ? value.offset : typeof value.byteOffset === "number" ? value.byteOffset : value.nextOffset - bytes.length;
    candidate = truncatedEnvelope({ ...value, data, bytesRead, nextOffset: offset + bytesRead, eof: false, truncated: true }, originalBytes, maxBytes);
    if (typeof value.startLine === "number") {
      const linesRead = (data.match(/\n/g) ?? []).length;
      Object.assign(candidate, { linesRead, nextLine: value.startLine + linesRead, partialLine: !data.endsWith("\n") });
    }
  } else if (typeof value.stdout === "string" && typeof value.stderr === "string") {
    const stdout = utf8Preview(value.stdout, 2048), stderr = utf8Preview(value.stderr, 2048);
    candidate = truncatedEnvelope({ ...value, stdout, stderr,
      stdoutTruncated: value.stdoutTruncated === true || stdout !== value.stdout,
      stderrTruncated: value.stderrTruncated === true || stderr !== value.stderr,
      stdoutReturnedBytes: Buffer.byteLength(stdout), stderrReturnedBytes: Buffer.byteLength(stderr) }, originalBytes, maxBytes);
  }
  if (candidate && jsonBytes(candidate) <= maxBytes && (!schema || schema.safeParse(candidate).success)) return candidate;
  return truncatedEnvelope({ resultOmitted: true, resultRecovery: value.resultRecovery, ...(value.summary ? { summary: value.summary } : {}) }, originalBytes, maxBytes);
}

/** History payload fields may be previewed, but never identifiers or cursors.
 * Full row contents remain available through the page's resultRecovery. */
export function compactHistoryPage(value: Record<string, unknown>, maxBytes = STRUCTURED_CONTENT_MAX_BYTES): Record<string, unknown> {
  const originalBytes = jsonBytes(value);
  if (originalBytes <= maxBytes) return value;
  if (!Array.isArray(value.items)) throw new Error("Invalid job history page");
  const items = (value.items as Array<Record<string, unknown>>).map(item => {
    if (jsonBytes(item) <= 8192) return item;
    return { id: item.id, state: item.state, startedAt: item.startedAt,
      ...(typeof item.command === "string" ? { command: utf8Preview(item.command, 1024), commandTruncated: true } : {}),
      detailsOmitted: true, detailsTool: "job_status" };
  });
  let low = 1, high = items.length;
  let best: Record<string, unknown> | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const last = items[count - 1]!;
    const nextCursor = count < items.length ? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url") : value.nextCursor;
    const candidate = truncatedEnvelope({ ...value, items: items.slice(0, count), nextCursor }, originalBytes, maxBytes);
    if (jsonBytes(candidate) <= maxBytes) { best = candidate; low = count + 1; }
    else high = count - 1;
  }
  return best ?? compactStructuredContent(value, maxBytes);
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
  const recovery = new ResultRecoveryStore();
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
      const detail: ResultDiagnostic = {};
      let outcome: ReturnType<typeof toolOutcome> = "error";
      let reference: ReturnType<ResultRecoveryStore["begin"]> | undefined;
      try {
        if (!name.startsWith("result_recover")) {
          // A caller can reserve the ID before effects. Unknown/reused IDs fail
          // closed; recovery is never an execution retry mechanism.
          const requested = extra?._meta?.resultRecoveryId;
          if (requested !== undefined && typeof requested !== "string") throw new Error("Invalid resultRecoveryId");
          if (requested !== undefined) reference = recovery.reference(requested);
          reference = recovery.begin(requested, { tool: name, requestId: extra?.requestId, sessionId: extra?.sessionId });
        }
        const result = await withToolErrors(() => callback(...args));
        if (!result || typeof result !== "object") {
          if (reference) reference = recovery.finish(reference.id, { resultInvalid: true, callbackResult: result ?? null });
          throw new Error("Invalid tool result");
        }
        const current = (result as any).structuredContent;
        const structured = current && typeof current === "object" && !Array.isArray(current)
          ? current as Record<string, unknown> : structuredFromContent((result as any).content);
        if (reference) reference = recovery.finish(reference.id, { ...result, structuredContent: structured });
        if (name === "exec") {
          detail.execution = { [executionOutcome(structured)]: 1 };
          detail.requestErrors = Number((result as any).isError === true);
        } else if (name === "batch_exec" && structured.summary && typeof structured.summary === "object") {
          detail.execution = structured.summary as ResultDiagnostic["execution"];
          detail.requestErrors = (structured.summary as any).requestErrors;
        }
        const full = { ...structured, ...(reference ? { resultRecovery: reference } : {}) };
        const historyPage = name === "job_history" || (name === "job_list" && Object.hasOwn(structured, "nextCursor"));
        let final = historyPage && !(result as any).isError ? compactHistoryPage(full) : compactStructuredContent(full, STRUCTURED_CONTENT_MAX_BYTES, advertisedSchema);
        const failedValidation = !advertisedSchema.safeParse(final).success;
        if (failedValidation) {
          detail.finalValidationFailed = true;
          final = { ok: false, error: "Final result validation failed; inspect resultRecovery without replaying the operation.", code: "result_validation_failed", ...(reference ? { resultRecovery: reference } : {}) };
        }
        // Keep small legacy representations compatible. Once a page/preview is
        // shortened both channels carry exactly the same cursors and counts.
        let output = { ...result, ...(failedValidation ? { isError: true } : {}), structuredContent: final } as any;
        if (jsonBytes(output) > TOTAL_RESULT_MAX_BYTES && !final.structuredContentTruncated && !failedValidation) {
          final = compactStructuredContent({ ...final, contentTruncated: true, contentOriginalBytes: jsonBytes((result as any).content), totalResultLimitBytes: TOTAL_RESULT_MAX_BYTES }, STRUCTURED_CONTENT_MAX_BYTES, advertisedSchema);
          output.structuredContent = final;
        }
        if (final.structuredContentTruncated || final.contentTruncated || failedValidation || jsonBytes(output) > TOTAL_RESULT_MAX_BYTES) {
          output = { isError: output.isError, content: [{ type: "text", text: JSON.stringify(final) }], structuredContent: final };
        }
        // Validate the actual object, after every wrapper. The contract uses the
        // exact advertised JSON Schema in addition to Zod's semantic refinements.
        if (!advertisedSchema.safeParse(output.structuredContent).success || jsonBytes(output) > TOTAL_RESULT_MAX_BYTES) throw new Error("Final result exceeds its delivery contract");
        outcome = failedValidation ? "error" : toolOutcome(output, structured, extra?.signal, name);
        return output;
      } catch (error) {
        detail.resultPreparationFailed = true;
        const failure = await withToolErrors<never>(() => { throw reference
          ? new OperationReceiptError("Result delivery failed; recover the retained receipt without replay.", { code: "result_delivery_failed", resultRecovery: reference })
          : error; });
        if (!advertisedSchema.safeParse(failure.structuredContent).success || jsonBytes(failure) > TOTAL_RESULT_MAX_BYTES) throw new Error("Invalid final error receipt");
        return failure;
      } finally {
        stopProgress();
        diagnostics?.record(name, args[0], performance.now() - started, outcome, detail);
      }
    };
    const annotations = readOnlyTools.has(name)
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...config?.annotations }
      : config?.annotations;
    return original(name, { ...config, ...(annotations ? { annotations } : {}), outputSchema: advertisedSchema }, wrappedCallback);
  };
  installedServers.add(server);
  registerResultRecovery(server, recovery);
}
