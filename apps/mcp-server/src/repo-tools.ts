import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { executionInputSchema, resolveExecutionContext } from "./execution-identity.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const structured = (value: Record<string, unknown>) => ({ ...text(value), structuredContent: value });

export function registerRepoTools(server: McpServer, client: AgentClient): void {
  server.registerTool("repo_git_path", {
    description: "Resolve a Git-internal path through normal repositories or linked worktrees without assuming .git is a directory.",
    inputSchema: executionInputSchema({
      device: z.string().min(1), path: z.string().min(1), gitPath: z.string().min(1),
    }),
    outputSchema: {
      root: z.string().nullable(),
      gitDir: z.string().nullable(),
      commonGitDir: z.string().nullable(),
      gitPath: z.string(),
      resolved: z.string().nullable(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device, context, identity, elevation, ...input }) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    return structured(await client.repoGitPath(device, input, target) as Record<string, unknown>);
  });
}
