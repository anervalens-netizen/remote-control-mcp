import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { createDeadline } from "../../../packages/protocol/src/deadline.ts";
import { mapLimit } from "./concurrency.ts";
import { fleetProbeBudget } from "./fleet-probe.ts";
import { readVersionInventory, endpointVersionEvidence } from "./version-evidence.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

type EndpointResult = { ok: true; info: unknown } | { ok: false; error: string };
type CapabilityProbeOptions = { probeTimeoutMs?: number; signal?: AbortSignal };
const maxCapabilityDevices = 64;

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
  options.signal?.throwIfAborted();
  // Apply this report's 64-entry limit to explicit selections and the configured
  // inventory. Validate before any endpoint starts, then collapse aliases onto
  // their canonical identity.
  const selected = requestedDevices?.length ? requestedDevices : client.devices;
  if (selected.length > maxCapabilityDevices)
    throw new RangeError("Capability reports support at most 64 device entries; select a bounded subset.");
  const devices = [...new Set(requestedDevices?.length
    ? requestedDevices.map(device => client.getDevice(device).name)
    : client.devices.map(device => device.name))];
  const probeBudgetMs = fleetProbeBudget(options.probeTimeoutMs);
  const versionInventory = readVersionInventory();
  return mapLimit(devices, concurrency === undefined ? undefined : Math.min(32, concurrency), async (device) => {
    const started = performance.now();
    const configured = client.configuredContexts(device);
    const skipAutomatic = !requestedDevices?.length && client.devices.some(entry => entry.name === device && entry.expectedAvailability === "manual");
    const contexts: AgentEndpointContext[] = [];
    if (configured.system) contexts.push("system");
    if (configured.user) contexts.push("user");
    if (configured.desktop) contexts.push("desktop");
    const entries = await mapLimit(contexts, Math.min(contexts.length, 3),
      async (context) => {
        const result: EndpointResult = skipAutomatic
          ? { ok: false, error: "Manual selection required; endpoint was not probed." }
          : await endpointInfo(client, device, context, probeBudgetMs, options.signal);
        return [context, result] as const;
      },
      options.signal);
    const endpoints = Object.fromEntries(entries);
    const versions = Object.fromEntries(entries.map(([context, result]) => {
      const selected = context === "system" ? "root" : context === "user" ? "owner" : "interactive";
      return [selected, endpointVersionEvidence(result, versionInventory, device, selected)] as const;
    }));
    return { device, configured, endpoints, versions, ...(skipAutomatic ? { probeSkipped: "manual_selection_required" } : {}),
      probeBudgetMs, probeBudgetScope: "per_endpoint_timeout" as const, reportDeviceLimit: maxCapabilityDevices,
      probeDurationMs: performance.now() - started, observedAt: new Date().toISOString() };
  }, options.signal);
}

export function registerCapabilityTools(server: McpServer, client: AgentClient): void {
  server.registerTool("capability_report", {
    description: "Probe up to 64 configured device entries, resolving aliases and probing each canonical device once. Each endpoint has a finite read-only timeout; concurrent calls have independent limits, not a shared rate quota. Manual-only devices require explicit selection. Reports runtime SHA/version/context plus separately sourced desired, installed and startup targets, with explicit unknowns and operator-declaration provenance. Endpoint probe failures retain independent runtime uncertainty. A probe timeout does not establish physical power state.",
    inputSchema: {
      devices: z.array(z.string().min(1)).max(maxCapabilityDevices).optional().describe("At most 64 entries; aliases and repeated canonical devices are deduplicated before probing. Omitted or empty selects the configured inventory, which must also fit the limit."),
      concurrency: z.number().int().min(1).max(32).optional(),
      probeTimeoutMs: z.number().int().min(100).max(30_000).optional().describe("Per-endpoint read-only probe budget. Uses RCMCP_HEALTH_PROBE_TIMEOUT_MS or 1500 ms by default; does not change command execution deadlines."),
    },
  }, async ({ devices, concurrency, probeTimeoutMs }, extra) => text(await capabilityReport(client, devices, concurrency, { probeTimeoutMs, signal: extra.signal })));
}
