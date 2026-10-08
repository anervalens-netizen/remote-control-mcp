import { McpServer, createMcpHandler, type ServerContext } from "@modelcontextprotocol/server";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentInstructions } from "./instructions.ts";
import { consoleResource, consoleIcon } from "./console-resource.ts";

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
export function createModernMcpHandler(registry: () => Record<string, unknown>) {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "remote-control-mcp", version: "0.1.0" },
      { instructions: agentInstructions, supportedProtocolVersions: ["2026-07-28"] },
    );
    server.registerResource(consoleResource.name, consoleResource.uri, consoleResource.metadata, consoleResource.read);
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
          _meta: ctx.mcpReq._meta,
          sendNotification: notification => ctx.mcpReq.notify(notification),
        };
        return handler(args, extra);
      };
      if (tool.inputSchema) {
        server.registerTool(name, { ...config, inputSchema: tool.inputSchema as z.ZodType }, invoke);
      } else {
        server.registerTool(name, config, ctx => invoke(undefined, ctx));
      }
    }
    return server;
  }, { legacy: "reject" });
}
