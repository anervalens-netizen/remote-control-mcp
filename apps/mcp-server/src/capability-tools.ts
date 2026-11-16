import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { createDeadline } from "../../../packages/protocol/src/deadline.ts";
import { mapLimit } from "./concurrency.ts";
import { fleetProbeBudget } from "./fleet-probe.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

type EndpointResult = { ok: true; info: unknown } | { ok: false; error: string };
type CapabilityProbeOptions = { probeTimeoutMs?: number; signal?: AbortSignal };

async function endpointInfo(
  client: AgentClient, device: string, context: AgentEndpointContext,
  probeTimeoutMs: number, callerSignal?: AbortSignal,
): Promise<EndpointResult> {
  callerSignal?.throwIfAborted();
  const deadline = createDeadline(probeTimeoutMs, callerSignal);
  try {
    const info = await client.info(device, context, { timeoutMs: probeTimeoutMs, signal: deadline.signal });
    deadline.signal?.throwIfAborted();
    return { ok: true, info };
  } catch (error) {
    // Caller cancellation ends the report and prevents queued probes. An
    // endpoint budget expiry is a partial observation, not a fleet failure.
    callerSignal?.throwIfAborted();
    return { ok: false, error: deadline.timedOut()
      ? "Capability probe exceeded its read-only budget; readiness and power state remain unknown."
      : error instanceof Error ? error.message : String(error) };
  } finally { deadline.dispose(); }
}

export async function capabilityReport(
  client: AgentClient, requestedDevices?: string[], concurrency?: number, options: CapabilityProbeOptions = {},
) {
  const devices = requestedDevices?.length ? requestedDevices : client.devices.map((item) => item.name);
  const probeBudgetMs = fleetProbeBudget(options.probeTimeoutMs);
  return mapLimit(devices, concurrency, async (device) => {
    const started = performance.now();
    const configured = client.configuredContexts(device);
    const contexts: AgentEndpointContext[] = [];
    if (configured.system) contexts.push("system");
    if (configured.user) contexts.push("user");
    if (configured.desktop) contexts.push("desktop");
    const entries = await mapLimit(contexts, Math.min(contexts.length, 3),
      async (context) => [context, await endpointInfo(client, device, context, probeBudgetMs, options.signal)] as const,
      options.signal);
    return { device, configured, endpoints: Object.fromEntries(entries),
      probeBudgetMs, probeDurationMs: performance.now() - started, observedAt: new Date().toISOString() };
  }, options.signal);
}

export function registerCapabilityTools(server: McpServer, client: AgentClient): void {
  server.registerTool("capability_report", {
    description: "Probe configured agent endpoints within a finite read-only budget and report runtime SHA/version/context, privileges, readiness and capabilities with per-endpoint partial failures. A probe timeout does not establish physical power state.",
    inputSchema: {
      devices: z.array(z.string().min(1)).optional(),
      concurrency: z.number().int().min(1).max(32).optional(),
      probeTimeoutMs: z.number().int().min(100).max(30_000).optional().describe("Per-endpoint read-only probe budget. Uses RCMCP_HEALTH_PROBE_TIMEOUT_MS or 1500 ms by default; does not change command execution deadlines."),
    },
  }, async ({ devices, concurrency, probeTimeoutMs }, extra) => text(await capabilityReport(client, devices, concurrency, { probeTimeoutMs, signal: extra.signal })));
}
