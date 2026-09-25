import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { advancedClient } from "./advanced-client.ts";
import { searchInputSchema } from "./search-tools.ts";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
const contextSchema = z.enum(["system", "user"]).optional();

export function registerAdvancedTools(server: McpServer, client: AgentClient): void {
  server.registerTool("search", {
    description: "Fast ripgrep-backed file or content search on a remote computer.",
    inputSchema: searchInputSchema,
  }, async ({ device, context, ...input }) => text(await advancedClient.search(client, device, input, context)));

  server.registerTool("service_manage", {
    description: "Inspect or control a Linux systemd or Windows Service Manager service.",
    inputSchema: {
      device: z.string().min(1), name: z.string().min(1),
      action: z.enum(["status", "start", "stop", "restart", "enable", "disable"]),
      scope: z.enum(["user", "system"]).optional(),
    },
  }, async ({ device, ...input }) => text(await advancedClient.service(client, device, input)));

  server.registerTool("service_logs", {
    description: "Read recent Linux journal or Windows Service Control Manager events for a service.",
    inputSchema: {
      device: z.string().min(1), name: z.string().min(1), scope: z.enum(["user", "system"]).optional(),
      lines: z.number().int().positive().optional(),
    },
  }, async ({ device, ...input }) => text(await advancedClient.logs(client, device, input)));

  server.registerTool("system_metrics", {
    description: "Return CPU/memory/root-storage metrics in light mode or full network/filesystem metrics in full mode.",
    inputSchema: { device: z.string().min(1), context: contextSchema, profile: z.enum(["light", "full"]).optional() },
  }, async ({ device, context, profile }) => text(await advancedClient.metrics(client, device, context, profile ?? "full")));
}
