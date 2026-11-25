import { McpServer, ProtocolError, createMcpHandler, type ServerContext } from "@modelcontextprotocol/server";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentInstructions } from "./instructions.ts";
import { legacyConsoleResources, consoleResource, consoleIcon } from "./console-resource.ts";
import { attachRemoteControlSkills } from "./mcp-skills.ts";
import { ExtensionError, FILES_EXTENSION, MAX_INLINE_BYTES, TASKS_EXTENSION, WIRE_RESULT, extensionSettings } from "./mcp-extension-store.ts";
import { McpTasks } from "./mcp-tasks.ts";
import { McpFiles, uploadSchema } from "./mcp-files.ts";

type HandlerContext = {
  signal: AbortSignal;
  requestId: string | number;
  sessionId?: string;
  _meta?: Record<string, unknown>;
  sendNotification: ServerContext["mcpReq"]["notify"];
};
type Handler = (args: unknown, extra: HandlerContext) => Promise<CallToolResult>;

/** Keep one source of tool behavior and recovery state across both wire eras.
 * The SDK owns modern framing, envelope validation, errors and cancellation.
 * This boundary translates only the callback context used by our tool handlers.
 */
export function createModernMcpHandler(registry: () => Record<string, unknown>, extensions: { tasks: McpTasks; files: McpFiles }) {
  const metadata = (ctx: ServerContext) => ({ ...ctx.mcpReq._meta, ...ctx.mcpReq.envelope });
  const factory = () => {
    const server = new McpServer(
      { name: "remote-control-mcp", version: "0.1.0" },
      {
        instructions: agentInstructions,
        supportedProtocolVersions: ["2026-07-28"],
        // Catalogs are immutable until the controller release changes.
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, extensions: { [TASKS_EXTENSION]: {}, [FILES_EXTENSION]: { upload: {}, maxInlineBytes: MAX_INLINE_BYTES } } },
      },
    );
    attachRemoteControlSkills(server);
    const taskParams = z.object({ taskId: z.string().min(1).max(4096) });
    for (const method of ["tasks/get", "tasks/cancel", "tasks/update"] as const) {
      server.server.setRequestHandler(method, { params: method === "tasks/update" ? taskParams.extend({ inputResponses: z.record(z.string(), z.unknown()) }) : taskParams }, async (params, ctx) => {
        if (ctx.http?.req?.headers.get("Mcp-Name") !== params.taskId) throw new ProtocolError(-32020, "Mcp-Name must equal taskId");
        try {
          if (method === "tasks/get") return await extensions.tasks.get(params.taskId, metadata(ctx));
          if (method === "tasks/cancel") return await extensions.tasks.cancel(params.taskId, metadata(ctx));
          return await extensions.tasks.update(params.taskId, (params as unknown as { inputResponses: Record<string, unknown> }).inputResponses, metadata(ctx));
        } catch (error) { if (error instanceof ExtensionError) throw new ProtocolError(error.code, error.message, error.data); throw error; }
      });
    }
    server.registerResource(consoleResource.name, consoleResource.uri, consoleResource.metadata, consoleResource.read);
  for (const resource of legacyConsoleResources) server.registerResource(resource.name, resource.uri, resource.metadata, resource.read);
    for (const [name, value] of Object.entries(registry())) {
      const tool = value as RegisteredTool;
      if (!tool.enabled) continue;
      if (typeof tool.handler !== "function") throw new Error("Unsupported MCP tool handler kind");
      const handler = tool.handler as unknown as Handler;
      const config = {
        ...(name === "open_remote_control_console" ? { icons: [consoleIcon] } : {}),
        title: tool.title,
        description: tool.description,
        outputSchema: tool.outputSchema as z.ZodType | undefined,
        annotations: tool.annotations,
        _meta: tool._meta,
      };
      const invoke = async (args: unknown, ctx: ServerContext) => {
        const extra: HandlerContext = {
          signal: ctx.mcpReq.signal,
          requestId: ctx.mcpReq.id,
          sessionId: ctx.sessionId,
          _meta: metadata(ctx),
          sendNotification: notification => ctx.mcpReq.notify(notification),
        };
        if (name === "file_upload") {
          try {
            const native = await extensions.files.upload(uploadSchema.parse(args), metadata(ctx), ctx.mcpReq.requestState<string>());
            if (native.resultType === "complete") { const { resultType: _type, ...complete } = native; return complete as unknown as CallToolResult; }
            return { content: [{ type: "text" as const, text: "File transfer is pending" }], structuredContent: { uploadPending: true }, _meta: { [WIRE_RESULT]: { result: native } } };
          } catch (error) {
            if (error instanceof ExtensionError) return { content: [{ type: "text" as const, text: error.message }], isError: true, _meta: { [WIRE_RESULT]: { error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } } } };
            throw error;
          }
        }
        const asTask = name === "job_start" && extensionSettings(metadata(ctx), TASKS_EXTENSION) !== undefined;
        // Key persistence is prepared before dispatch; losing the response
        // must never turn a key-storage failure into a replacement execution.
        if (asTask) await extensions.tasks.prepare();
        const result = await handler(args, extra);
        if (asTask) {
          const task = await extensions.tasks.created((args as { device: string }).device, result);
          if (task) return { ...result, _meta: { ...result._meta, [WIRE_RESULT]: { result: task } } };
        }
        return result;
      };
      if (tool.inputSchema) {
        server.registerTool(name, { ...config, inputSchema: tool.inputSchema as z.ZodType }, invoke);
      } else {
        server.registerTool(name, config, ctx => invoke(undefined, ctx));
      }
    }
    return server;
  };
  const handler = createMcpHandler(factory, { legacy: "reject" });
  const extensionHandler = createMcpHandler(factory, { legacy: "reject", responseMode: "json" });
  return {
    ...handler,
    async fetch(request: Request, options?: Parameters<typeof handler.fetch>[1]): Promise<Response> {
      let body: { method?: string; params?: { name?: string; _meta?: Record<string, unknown> } } | undefined;
      if (request.method === "POST") { try { body = await request.clone().json(); } catch { /* SDK owns malformed input errors. */ } }
      const extensionCall = body?.method === "tools/call" && (body.params?.name === "file_upload" || body.params?.name === "job_start" && extensionSettings(body.params?._meta, TASKS_EXTENSION) !== undefined);
      if (!extensionCall) return handler.fetch(request, options);
      const response = await extensionHandler.fetch(request, options);
      if (!response.headers.get("content-type")?.includes("application/json")) return response;
      const payload = await response.json() as { result?: { _meta?: Record<string, unknown> }; [key: string]: unknown };
      const wire = payload.result?._meta?.[WIRE_RESULT] as { result?: Record<string, unknown>; error?: Record<string, unknown> } | undefined;
      if (wire) {
        const meta = { ...payload.result?._meta }; delete meta[WIRE_RESULT];
        delete payload.result;
        if (wire.error) payload.error = wire.error;
        else if (wire.result) payload.result = { ...wire.result, _meta: { ...meta, ...(wire.result._meta as Record<string, unknown> ?? {}) } };
      }
      // SDK validation and callback execution completed once. This narrow
      // encode seam adds beta result variants not yet shipped in SDK 2.4.
      const headers = new Headers(response.headers); headers.delete("content-length");
      return new Response(JSON.stringify(payload), { status: response.status, headers });
    },
    async close() { await Promise.all([handler.close(), extensionHandler.close()]); },
  };
}
