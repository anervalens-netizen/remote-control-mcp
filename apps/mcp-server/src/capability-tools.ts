import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { mapLimit } from "./concurrency.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

type EndpointResult = { ok: true; info: unknown } | { ok: false; error: string };

async function endpointInfo(client: AgentClient, device: string, context: AgentEndpointContext): Promise<EndpointResult> {
  try { return { ok: true, info: await client.info(device, context) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function capabilityReport(client: AgentClient, requestedDevices?: string[], concurrency?: number) {
  const devices = requestedDevices?.length ? requestedDevices : client.devices.map((item) => item.name);
  return mapLimit(devices, concurrency, async (device) => {
    const configured = client.configuredContexts(device);
    const contexts: AgentEndpointContext[] = [];
    if (configured.system) contexts.push("system");
    if (configured.user) contexts.push("user");
    if (configured.desktop) contexts.push("desktop");
    const entries = await mapLimit(contexts, Math.min(contexts.length, 3), async (context) => [context, await endpointInfo(client, device, context)] as const);
    return { device, configured, endpoints: Object.fromEntries(entries) };
  });
}

export function registerCapabilityTools(server: McpServer, client: AgentClient): void {
  server.registerTool("capability_report", {
    description: "Probe configured agent endpoints and report actual runtime SHA/version/context, privileges, readiness and capabilities with per-endpoint partial failures.",
    inputSchema: { devices: z.array(z.string().min(1)).optional(), concurrency: z.number().int().min(1).max(32).optional() },
  }, async ({ devices, concurrency }) => text(await capabilityReport(client, devices, concurrency)));
}
