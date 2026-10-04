import { resultMetadataFields } from "./result-recovery.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coordinationRequestSchema, coordinationRecordSchema, coordinationTokenSchema } from "../../../packages/protocol/src/coordination.ts";
import type { AgentClient } from "./agent-client.ts";
import { executionInputSchema, resolveExecutionContext } from "./execution-identity.ts";
export function registerCoordinationTools(server: McpServer, client: AgentClient) {
  server.registerTool("resource_coordination", {
    description: "Inspect, reserve or release a canonical high-level repository/project/deploy/service resource. Pass the returned token as coordination to the high-level write. Owner override only replaces a reservation, audits the previous writer and revalidates base/generation; active/uncertain effects cannot be evicted. No raw commands or secrets are stored.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...coordinationRequestSchema.shape }),
    outputSchema: z.union([
      z.object({ ...resultMetadataFields, record: coordinationRecordSchema, token: coordinationTokenSchema.optional() }).strict(),
      z.object({ ...resultMetadataFields, resourceId: z.string(), device: z.string(), identity: z.string(), canonicalKey: z.string(), observedBaseVersion: z.string(), record: coordinationRecordSchema.nullable(), activeBudget: z.number().int().positive() }).strict(),
    ]),
  }, async ({ device, context, identity, elevation, ...input }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    const result = await client.requestRoute<Record<string, unknown>>(device, "/v1/coordination", input, target, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
}
