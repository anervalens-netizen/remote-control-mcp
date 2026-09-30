import { randomUUID } from "node:crypto";
import { CallToolResultSchema, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

export const errorCategories = ["transport", "timeout", "cancelled", "http", "content_type", "too_large", "invalid_response", "rpc_error", "tool_error", "ack_mismatch", "proof_missing", "remote_conflict", "journal", "executor"] as const;
export type ErrorCategory = typeof errorCategories[number];
export class BridgeError extends Error {
  readonly category: ErrorCategory;
  constructor(category: ErrorCategory) { super(`ContextKeep bridge: ${category}`); this.category = category; }
}
export function categoryOf(error: unknown): ErrorCategory {
  return error instanceof BridgeError ? error.category : "transport";
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new BridgeError("invalid_response"); }
}
function payload(message: unknown, id: string, stream: boolean): unknown {
  const parsed = JSONRPCMessageSchema.safeParse(message);
  if (!parsed.success || !object(message)) throw new BridgeError("invalid_response");
  if (message.id !== id) {
    if (stream) return undefined; // Notifications and other requests' replies are not our ACK.
    throw new BridgeError("invalid_response");
  }
  if (("result" in message) === ("error" in message)) throw new BridgeError("invalid_response");
  if ("error" in message) throw new BridgeError("rpc_error");
  const result = CallToolResultSchema.safeParse(message.result);
  if (!result.success) throw new BridgeError("invalid_response");
  if (result.data.isError) throw new BridgeError("tool_error");
  // Both encodings are legal MCP tool results; older servers return only text JSON.
  if (result.data.structuredContent !== undefined) return result.data.structuredContent;
  const content = result.data.content;
  if (content.length !== 1 || content[0]?.type !== "text") throw new BridgeError("invalid_response");
  const value = parse(content[0].text);
  if (!object(value)) throw new BridgeError("invalid_response");
  return value;
}

/** No reconnect/replay: SDK transport owns reconnects and unbounded body parsing.
 * Reuse its message schemas, retaining a byte/deadline bound on this one POST. */
export async function callContextKeep(
  config: { url: string; token: string }, name: string, args: Record<string, unknown>,
  signal?: AbortSignal, timeoutMs = 10_000,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new BridgeError("timeout")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const id = randomUUID();
    const response = await fetch(config.url, {
      method: "POST", redirect: "error", signal: combined,
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    reader = response.body?.getReader();
    if (!response.ok) throw new BridgeError("http");
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json" && type !== "text/event-stream") throw new BridgeError("content_type");
    if (!reader) throw new BridgeError("invalid_response");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, buffer = "", data: string[] = [], event = "";
    for (;;) {
      const chunk = await reader.read();
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > 1024 * 1024) throw new BridgeError("too_large");
      }
      try { buffer += decoder.decode(chunk.value, { stream: !chunk.done }); }
      catch { throw new BridgeError("invalid_response"); }
      if (type === "application/json") {
        if (chunk.done) return payload(parse(buffer), id, false);
        continue;
      }
      // SSE lines can end in CR, LF or CRLF, including a split CRLF/UTF-8 chunk.
      for (;;) {
        const match = /[\r\n]/.exec(buffer);
        if (!match || (match[0] === "\r" && match.index === buffer.length - 1 && !chunk.done)) break;
        const line = buffer.slice(0, match.index);
        const length = match[0] === "\r" && buffer[match.index + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(match.index + length);
        if (line === "") {
          if (data.length && (!event || event === "message")) {
            const value = payload(parse(data.join("\n")), id, true);
            // Return at the correlated event, even when the server keeps SSE open.
            if (value !== undefined) return value;
          }
          data = []; event = "";
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") data.push(value);
          if (field === "event") event = value;
        }
      }
      if (chunk.done) throw new BridgeError("invalid_response"); // No complete matching event.
    }
  } catch (error) {
    if (combined.aborted) throw controller.signal.aborted ? new BridgeError("timeout") : new BridgeError("cancelled");
    throw error instanceof BridgeError ? error : new BridgeError("transport");
  } finally {
    clearTimeout(timeout);
    // Cancellation is initiated but never allowed to extend the response deadline.
    if (reader) void reader.cancel().catch(() => {});
    controller.abort();
  }
}
