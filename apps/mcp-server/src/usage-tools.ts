import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { dispatchesFor } from "./agent-dispatch-observer.ts";
import { executionInputSchema, executionLabel, resolveExecutionContext } from "./execution-identity.ts";
import { ingressQueryFields } from "../../../packages/protocol/src/ingress-correlation.ts";

export function registerUsageTools(server: McpServer, client: AgentClient) {
  server.registerTool("usage_report", {
    description: "Read bounded agent ingress counters, UTC daily history and optional trace/route pages for one execution identity. Includes direct and controller traffic; separates authenticated bearer possession from caller-declared correlation. Counts requests, not completed tasks or verified effects. History starts at collection and cannot reconstruct older weeks. Requires agent-ingress-v1; no workload execution or replay.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...ingressQueryFields }),
    outputSchema: z.object({
      version: z.literal(1), device: z.string(), identity: z.enum(["root", "owner", "interactive"]),
      agent: z.record(z.string(), z.unknown()), controller: z.record(z.string(), z.unknown()),
      comparison: z.object({ automaticSameWindowReconciliation: z.literal(false), reason: z.string() }),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ device, context, identity, elevation, ...query }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    const canonical = client.getDevice(device).name;
    const selected = executionLabel(target);
    const agent = await client.requestRoute<Record<string, unknown>>(canonical, "/v1/observations/ingress", query, target,
      { timeoutMs: 5000, signal: extra.signal, observeOperation: false });
    if (!agent || agent.version !== 1 || typeof agent.instanceId !== "string" || !agent.totals || !agent.history) {
      throw new Error("Agent ingress report has an unsupported or incomplete contract");
    }
    const controller = dispatchesFor(client).snapshot(canonical, selected, { sampleOffset: query.sampleOffset, sampleLimit: query.sampleLimit ?? 16 });
    const value = {
      version: 1 as const, device: canonical, identity: selected, agent, controller,
      comparison: {
        automaticSameWindowReconciliation: false as const,
        reason: "Agent and controller lifetimes and capture instants differ. Compare stable receipts or explicitly bracket a same-instance window; unmatched traffic remains unassigned. Current snapshots include this diagnostic request.",
      },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  });
}
