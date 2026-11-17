import { resultMetadataFields } from "./result-recovery.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coordinationRequestSchema, coordinationRecordSchema, coordinationTokenSchema, coordinationRecoveryIntentSchema, coordinationRecoveryViewSchema, coordinationCapacitySnapshotSchema } from "../../../packages/protocol/src/coordination.ts";
import { agentCapabilities, requireAgentCapability } from "./agent-compatibility.ts";
import type { AgentClient } from "./agent-client.ts";
import { executionInputSchema, resolveExecutionContext } from "./execution-identity.ts";
export function registerCoordinationTools(server: McpServer, client: AgentClient) {
  server.registerTool("coordination_capacity", {
    description: "Bounded read-only observation of four host coordination slots. Reports state, age band, identity-match category and whether a durable binding or disposition is recorded; never exposes resource paths, tokens, job IDs, exact operation identifiers or execution effects. A bound job is NOT verified terminal. Orphan or unreadable evidence remains fenced. Does not release, retry or reconcile any operation. New agents advertise coordination-capacity-v1.",
    inputSchema: executionInputSchema({ device: z.string().min(1) }),
    outputSchema: z.object({ ...resultMetadataFields, ...coordinationCapacitySnapshotSchema.shape }).strict(),
  }, async ({ device, context, identity, elevation }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    await requireAgentCapability(client, device, target, agentCapabilities.coordinationCapacity, { signal: extra.signal });
    const result = await client.requestRoute<Record<string, unknown>>(
      device, "/v1/coordination/capacity", {}, target, { signal: extra.signal, observeOperation: false });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("resource_coordination", {
    description: "Inspect, reserve or release a canonical high-level resource. Pass its token to the write. inspect_recovery adds execution and resolution metadata without changing the fence. reconcile uses the original durable execution plus expectedCurrentBaseVersion, never replays it, and preserves partial/unknown effects. A rejected Git command boundary is reconciled from its retained hook evidence when the freshly observed base still equals the base that rejected invocation was admitted with; a failed hook or an unchanged HEAD alone never releases the writer. For old receipts, prepare_recovery captures an intent; reconciliation requires a proven original containment or a different boot identity observed after that intent. It never restarts the host. Owner override replaces reservations only; age, PID absence and agent restart cannot evict active/uncertain writers. Inspect first and preserve the returned token/base/intent.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...coordinationRequestSchema.shape }),
    outputSchema: z.union([
      z.object({ ...resultMetadataFields, record: coordinationRecordSchema, token: coordinationTokenSchema.optional(), alreadyReconciled: z.boolean().optional(), noReplay: z.literal(true).optional(), recoveryIntent: coordinationRecoveryIntentSchema.optional(), recovery: coordinationRecoveryViewSchema.optional() }).strict(),
      z.object({ ...resultMetadataFields, resourceId: z.string(), device: z.string(), identity: z.string(), canonicalKey: z.string(), observedBaseVersion: z.string(), record: coordinationRecordSchema.nullable(), activeBudget: z.number().int().positive(), recovery: coordinationRecoveryViewSchema.optional() }).strict(),
    ]),
  }, async ({ device, context, identity, elevation, ...input }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "user");
    if (["inspect_recovery", "prepare_recovery", "reconcile"].includes(input.action)) await requireAgentCapability(client, device, target, agentCapabilities.coordinationRecovery, { signal: extra.signal });
    const result = await client.requestRoute<Record<string, unknown>>(device, "/v1/coordination", input, target, { signal: extra.signal });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
}
