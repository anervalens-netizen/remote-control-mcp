import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { advancedClient } from "./advanced-client.ts";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
const contextSchema = z.enum(["system", "user"]).optional();
export const searchInputSchema = {
  device: z.string().min(1), path: z.string().min(1), pattern: z.string(), context: contextSchema,
  mode: z.enum(["content", "files"]).optional(), literal: z.boolean().optional(),
  ignoreCase: z.boolean().optional(), hidden: z.boolean().optional(), glob: z.string().optional(),
  globs: z.array(z.string()).max(256).optional(), types: z.array(z.string().min(1)).max(256).optional(),
  excludeTypes: z.array(z.string().min(1)).max(256).optional(), follow: z.boolean().optional(), noIgnore: z.boolean().optional(),
  maxFileSizeBytes: z.number().int().positive().optional(), maxResults: z.number().int().positive().optional(),
};

export function registerSearchSessionTools(server: McpServer, client: AgentClient): void {
  server.registerTool("search_start", {
    description: "Start a persistent remote search and return a session id after durable process identity is recorded.",
    inputSchema: searchInputSchema,
  }, async ({ device, context, ...input }) => text(await advancedClient.searchStart(client, device, input, context)));

  server.registerTool("search_results", {
    description: "Read a page of persistent search results. Use the returned nextCursor for efficient streaming; legacy offset paging remains supported.",
    inputSchema: {
      device: z.string().min(1), id: z.string().min(1), context: contextSchema,
      offset: z.number().int().nonnegative().optional(), length: z.number().int().positive().max(1000).optional(),
      cursor: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
    },
  }, async ({ device, context, ...input }) => text(await advancedClient.searchResults(client, device, input, context)));

  server.registerTool("search_stop", {
    description: "Stop a persistent remote search session.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), context: contextSchema },
  }, async ({ device, context, ...input }) => text(await advancedClient.searchStop(client, device, input, context)));

  server.registerTool("search_sessions", {
    description: "List persistent remote search sessions on a computer/context.",
    inputSchema: { device: z.string().min(1), context: contextSchema },
  }, async ({ device, context }) => text(await advancedClient.searchSessions(client, device, context)));

  server.registerTool("search_remove", {
    description: "Remove persisted search metadata/results; force can stop an active search first.",
    inputSchema: { device: z.string().min(1), id: z.string().min(1), force: z.boolean().optional(), context: contextSchema },
  }, async ({ device, context, ...input }) => text(await advancedClient.searchRemove(client, device, input, context)));
}
