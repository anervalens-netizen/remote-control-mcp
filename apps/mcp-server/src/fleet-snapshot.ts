import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { executionLabel, type ExecutionIdentity } from "./execution-identity.ts";
import { mapLimit } from "./concurrency.ts";
import { fleetProbeBudget, probeFleetHost } from "./fleet-probe.ts";

export type FleetInput = { devices?: string[]; context?: "system" | "user"; identity?: ExecutionIdentity; concurrency?: number; probeTimeoutMs?: number };

export async function fleetSnapshot(client: AgentClient, input: FleetInput = {}, signal?: AbortSignal) {
  const explicit = input.identity && input.identity !== "auto" ? input.identity : undefined;
  const requested = explicit === "root" ? "system" : explicit === "owner" ? "user" : explicit === "interactive" ? "desktop" : input.context;
  if (explicit && input.context && requested !== input.context) throw new Error("Conflicting fleet identity and context");
  const names = input.devices?.length ? input.devices : client.devices.map(d => d.name);
  const devices = await mapLimit(names, input.concurrency, async name => {
    signal?.throwIfAborted();
    const started = performance.now();
    try {
      const config = client.devices.find(d => [d.name, ...(d.aliases ?? [])].some(n => n.toLowerCase() === name.toLowerCase()));
      if (!config) throw new Error(`Unknown device: ${name}`);
      const device = config.name;
      const android = config.transport === "android-reverse";
      const context: AgentEndpointContext = requested ?? (android ? "user" : "system");
      const available = android ? context === "user" : context === "system" || (context === "user" ? Boolean(config.userUrl ?? config.desktopUrl) : Boolean(config.desktopUrl));
      const common = {
        device, requestedDevice: name, context, identity: executionLabel(context),
        requestedIdentity: input.identity ?? (input.context ? executionLabel(input.context) : "auto"),
        contextAvailable: available, identityConfigured: available,
        expectedAvailability: config.expectedAvailability ?? "continuous",
      };
      if (android) {
        const status = client.androidStatus(device) as { name: string; online: boolean; readiness: string; readinessReason: string; state: null | Record<string, unknown> };
        return { ...common, online: status.online, connectivity: status.online ? "reachable" : "unknown",
          observedAt: new Date().toISOString(), probeDurationMs: performance.now() - started,
          endpointResponded: available && status.online, agentResponseValid: available && status.online,
          metricsStatus: "not_applicable", platform: "android", hostname: status.state?.model ?? status.name,
          readiness: status.readiness, readinessReason: status.readinessReason,
          ...(available ? { network: status.state?.network ?? null, batteryPercent: status.state?.batteryPercent ?? null,
            screenOn: status.state?.screenOn ?? null, keyguardLocked: status.state?.keyguardLocked ?? null, accessibility: status.state?.accessibility ?? null }
            : { error: `${context} context is not configured for android-reverse`, reason: "Requested identity is not configured; device reachability is reported independently." }) };
      }
      if (!available) return { ...common, online: false, connectivity: "unknown", observedAt: new Date().toISOString(), probeDurationMs: performance.now() - started,
        endpointResponded: false, agentResponseValid: false, readiness: null, metricsStatus: "unavailable",
        reason: "Requested identity is not configured; no endpoint was probed and power state is unknown." };
      return { ...await probeFleetHost(client, device, context, fleetProbeBudget(input.probeTimeoutMs), signal), ...common };
    } catch (error) {
      signal?.throwIfAborted();
      return { device: name, online: false, connectivity: "unknown", observedAt: new Date().toISOString(), probeDurationMs: performance.now() - started,
        metricsStatus: "unavailable", error: error instanceof Error ? error.message : String(error) };
    }
  }, signal);
  return { devices };
}
