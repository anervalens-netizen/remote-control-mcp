import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { semanticActSchema, semanticObserveSchema } from "../../../packages/protocol/src/semantic-desktop.ts";
import type { AgentClient } from "./agent-client.ts";
import { requireAgentCapability } from "./agent-compatibility.ts";

const semanticOutput = {
  ok: z.boolean(), version: z.string().optional(), engineVersion: z.string().optional(),
  command: z.string().optional(), observationId: z.uuid().optional(), commandId: z.uuid().optional(),
  data: z.unknown().optional(), error: z.record(z.string(), z.unknown()).optional(),
  observation: z.record(z.string(), z.unknown()).optional(), recovered: z.boolean().optional(),
  replayed: z.boolean().optional(), applicationEffectVerified: z.boolean().optional(),
};

export function registerSemanticDesktopTools(server: McpServer, client: AgentClient) {
  const context = (device: string) => client.getDevice(device).desktopUrl ? "desktop" as const : "user" as const;
  const deliver = (value: Record<string, unknown>) => ({ isError: value.ok === false, content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
  server.registerTool("desktop_observe", {
    description: "Observe native desktop apps through agent-desktop on Linux or Windows. kind=status/apps/windows discovers readiness and targets; snapshot returns compact semantic UI and observationId. Use ref+observationId to drill into a region or kind=get to read a property. Partial snapshots are explicitly marked complete=false. When data.identity_unproven=true, refs cannot be used; take a fresh snapshot with a larger timeout. No screenshots or physical input. Requires the owner's graphical session for app observation.",
    inputSchema: { device: z.string().min(1), ...semanticObserveSchema.shape },
    outputSchema: semanticOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device, ...input }, extra) => {
    await requireAgentCapability(client, device, context(device), "desktop-semantic-v1", { signal: extra.signal });
    return deliver(await client.semanticDesktopObserve(device, input, context(device), extra.signal));
  });
  server.registerTool("desktop_act", {
    description: "Act on a ref from desktop_observe using the same observationId. Supply a stable UUID commandId: retries recover the recorded result without replay; mode=status reads it after uncertainty. Semantic input by default; headed=true explicitly permits cursor/focus effects. Read disposition: delivered_unverified is not application-level success. A fresh observation follows by default. Never substitute another action after uncertain delivery.",
    inputSchema: { device: z.string().min(1), ...semanticActSchema.shape },
    outputSchema: semanticOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ device, ...input }, extra) => {
    await requireAgentCapability(client, device, context(device), "desktop-semantic-v1", { signal: extra.signal });
    return deliver(await client.semanticDesktopAct(device, input, context(device), extra.signal));
  });
}
