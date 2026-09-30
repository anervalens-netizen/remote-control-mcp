import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callContextKeep } from "../apps/mcp-server/src/contextkeep-transport.ts";

type Plan = { chunks: Uint8Array[]; type?: string; open?: boolean; status?: number };
const bytes = (value: string) => new TextEncoder().encode(value);
const encoded = (id: string, value: unknown = { ok: true, note: "synthetic é水" }, text = false) => JSON.stringify({ jsonrpc: "2.0", id, result: text ? { content: [{ type: "text", text: JSON.stringify(value) }] } : { content: [], structuredContent: value } });
export function transportCases(mode: "memory" | "loopback") {
  describe(`bounded ContextKeep transport (${mode})`, () => {
    let server: Server | undefined;
    let url = "http://127.0.0.1/mcp", cancelled = false, requests = 0;
    let plan: (id: string) => Plan;
    beforeEach(async () => {
      cancelled = false; requests = 0;
      plan = id => ({ chunks: [bytes(encoded(id))] });
      if (mode === "memory") {
        vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
          requests++;
          expect(init.redirect).toBe("error");
          expect(new Headers(init.headers).get("accept")).toBe("application/json, text/event-stream");
          const p = plan(JSON.parse(String(init.body)).id);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of p.chunks) controller.enqueue(chunk);
              if (!p.open) controller.close();
              else init.signal?.addEventListener("abort", () => { cancelled = true; try { controller.error(new Error("aborted")); } catch {} }, { once: true });
            },
            cancel() { cancelled = true; },
          });
          return new Response(stream, { status: p.status ?? 200, headers: { "content-type": p.type ?? "application/json" } });
        }));
      } else {
        server = createServer(async (req, res) => {
          requests++;
          const buffers = []; for await (const chunk of req) buffers.push(chunk);
          const p = plan(JSON.parse(Buffer.concat(buffers).toString("utf8")).id);
          res.on("close", () => { if (!res.writableEnded) cancelled = true; });
          res.writeHead(p.status ?? 200, { "content-type": p.type ?? "application/json", ...(p.status === 302 ? { location: "/redirect" } : {}) });
          res.flushHeaders();
          for (const chunk of p.chunks) { if (res.destroyed) break; res.write(chunk); await new Promise<void>(resolve => setImmediate(resolve)); }
          if (!p.open) res.end();
        });
        await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(0, "127.0.0.1", resolve); });
        url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
      }
    });
    afterEach(async () => {
      vi.unstubAllGlobals();
      if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      server = undefined;
    });
    const call = (signal?: AbortSignal, timeout = 1000) => callContextKeep({ url, token: "synthetic-token" }, "attach_run_job", { leaseToken: "synthetic-secret" }, signal, timeout);
    for (const text of [false, true]) it(`accepts correlated JSON using ${text ? "text JSON" : "structuredContent"}`, async () => {
      plan = id => ({ chunks: [bytes(encoded(id, undefined, text))] });
      await expect(call()).resolves.toEqual({ ok: true, note: "synthetic é水" });
    });
    const failures: Array<[string, (id: string) => Plan, string]> = [
      ["empty JSON object", () => ({ chunks: [bytes("{}")] }), "invalid_response"],
      ["empty body", () => ({ chunks: [] }), "invalid_response"],
      ["unrelated id", () => ({ chunks: [bytes(encoded("unrelated"))] }), "invalid_response"],
      ["wrong protocol version", id => ({ chunks: [bytes(encoded(id).replace('"2.0"', '"1.0"'))] }), "invalid_response"],
      ["RPC error", id => ({ chunks: [bytes(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "synthetic-secret" } }))] }), "rpc_error"],
      ["tool error", id => ({ chunks: [bytes(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "synthetic-secret" }], isError: true } }))] }), "tool_error"],
      ["missing tool result", id => ({ chunks: [bytes(JSON.stringify({ jsonrpc: "2.0", id, result: {} }))] }), "invalid_response"],
      ["result and error", id => ({ chunks: [bytes(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] }, error: { code: -1, message: "synthetic-secret" } }))] }), "invalid_response"],
      ["malformed JSON", () => ({ chunks: [bytes("not-json synthetic-secret")] }), "invalid_response"],
      ["truncated JSON", () => ({ chunks: [bytes('{"jsonrpc":')] }), "invalid_response"],
      ["oversized JSON", () => ({ chunks: [bytes(" ".repeat(1024 * 1024 + 1))], open: true }), "too_large"],
      ["unexpected content type", id => ({ chunks: [bytes(encoded(id))], type: "text/html", open: true }), "content_type"],
      ["bad UTF8", () => ({ chunks: [new Uint8Array([0xc3, 0x28])] }), "invalid_response"],
      ["HTTP error", () => ({ chunks: [bytes("synthetic-secret")], status: 503, open: true }), "http"],
      ["SSE unrelated id only", () => ({ chunks: [bytes(`data: ${encoded("unrelated")}\n\n`)], type: "text/event-stream" }), "invalid_response"],
      ["SSE truncated event", id => ({ chunks: [bytes(`data: ${encoded(id)}\n`)], type: "text/event-stream" }), "invalid_response"],
      ["SSE malformed event", () => ({ chunks: [bytes("data: {\n\n")], type: "text/event-stream" }), "invalid_response"],
      ["SSE oversized comment", () => ({ chunks: [bytes(":" + "x".repeat(1024 * 1024))], type: "text/event-stream", open: true }), "too_large"],
    ];
    for (const [name, factory, category] of failures) it(`rejects ${name} with safe diagnostics`, async () => {
      plan = factory;
      await expect(call()).rejects.toMatchObject({ category, message: `ContextKeep bridge: ${category}` });
      expect(requests).toBe(1);
    });
    it("rejects redirects without following or retrying", async () => {
      plan = () => ({ chunks: [], status: 302 });
      await expect(call()).rejects.toMatchObject({ category: mode === "memory" ? "http" : "transport" });
      expect(requests).toBe(1);
    });
    it("matches SSE notifications/unrelated replies with chunked UTF8, CRLF and multiline data; cancels an open stream", async () => {
      plan = id => {
        const event = encoded(id, undefined, true).replace(',"result"', ',\ndata: "result"');
        const stream = ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n' +
          `data: ${encoded("other")}\r\n\r\nevent: message\r\ndata: ${event}\r\n\r\n`;
        return { chunks: [...bytes(stream)].map(b => new Uint8Array([b])), type: "text/event-stream; charset=utf-8", open: true };
      };
      await expect(call()).resolves.toEqual({ ok: true, note: "synthetic é水" });
      await vi.waitFor(() => expect(cancelled).toBe(true)); expect(requests).toBe(1);
    });
    it("bounds the lifetime of an SSE stream without a matching reply", async () => {
      plan = () => ({ chunks: [bytes(": heartbeat\n\n")], type: "text/event-stream", open: true });
      await expect(call(undefined, 100)).rejects.toMatchObject({ category: "timeout" });
      await vi.waitFor(() => expect(cancelled).toBe(true)); expect(requests).toBe(1);
    });
    it("cancels a pending transport without replay", async () => {
      plan = () => ({ chunks: [bytes(": heartbeat\n\n")], type: "text/event-stream", open: true });
      const controller = new AbortController(); const pending = call(controller.signal);
      await vi.waitFor(() => expect(requests).toBe(1)); controller.abort();
      await expect(pending).rejects.toMatchObject({ category: "cancelled" });
      await vi.waitFor(() => expect(cancelled).toBe(true)); expect(requests).toBe(1);
    });
  });
}
