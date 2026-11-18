/** Read-only bounded operator diagnosis. No remediation, screen capture or input. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import { createDeadline } from "../../../packages/protocol/src/deadline.ts";
import { fleetProbeBudget } from "./fleet-probe.ts";

type State = "ready" | "responded" | "not_ready" | "unavailable" | "unknown" | "not_configured";
type Stage = {
  name: string; identity: "root" | "owner" | "interactive" | null; state: State;
  cause: string; source: string; observedAt: string; elapsedMs: number | null;
};
type Probe = { stage: Stage; info?: Record<string, unknown> };
const identityFor = (context: AgentEndpointContext): Stage["identity"] =>
  context === "system" ? "root" : context === "user" ? "owner" : "interactive";
const finiteElapsed = (started: number) => Math.round((performance.now() - started) * 10) / 10;
const stage = (name: string, identity: Stage["identity"], state: State, cause: string, source: string,
  elapsedMs: number | null = null): Stage =>
  ({ name, identity, state, cause, source, elapsedMs, observedAt: new Date().toISOString() });

async function boundedInfo(client: AgentClient, device: string, context: AgentEndpointContext,
  timeoutMs: number, signal?: AbortSignal): Promise<Probe> {
  signal?.throwIfAborted();
  const started = performance.now(), identity = identityFor(context);
  const deadline = createDeadline(timeoutMs, signal);
  try {
    const value = await client.info(device, context, { timeoutMs, signal: deadline.signal });
    deadline.signal?.throwIfAborted();
    const info = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const runtime = info.runtime && typeof info.runtime === "object" ? info.runtime as Record<string, unknown> : {};
    const ready = runtime.ready;
    return { info, stage: stage("agent", identity, ready === true ? "ready" : ready === false ? "not_ready" : "responded",
      ready === false ? "agent_reports_not_ready" : ready === true ? "agent_reports_ready" : "agent_responded_readiness_unknown",
      "agent:/v1/info", finiteElapsed(started)) };
  } catch {
    signal?.throwIfAborted();
    return { stage: stage("agent", identity, "unknown",
      deadline.timedOut() ? "bounded_probe_expired_power_unknown" : "agent_probe_failed_power_unknown",
      "agent:/v1/info", finiteElapsed(started)) };
  } finally { deadline.dispose(); }
}
async function boundedDesktop(client: AgentClient, device: string, timeoutMs: number, signal?: AbortSignal, ownerInfo?: Record<string, unknown>) {
  signal?.throwIfAborted();
  const started = performance.now(), deadline = createDeadline(timeoutMs, signal);
  try {
    const raw = ownerInfo ? await client.desktopSessionStatus(device, deadline.signal, ownerInfo)
      : await client.desktopSessionStatus(device, deadline.signal);
    deadline.signal?.throwIfAborted();
    const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const interactive = data.interactiveSession === true;
    const inputDesktop = data.inputDesktop && typeof data.inputDesktop === "object" ? data.inputDesktop as Record<string, unknown> : {};
    const accessible = inputDesktop.accessible === true;
    const state: State = data.interactiveSession === false ? "unavailable" : interactive && accessible ? "ready"
      : interactive && inputDesktop.accessible === false ? "not_ready" : "unknown";
    return { stage: stage("graphical_session", "interactive", state,
      state === "unavailable" ? "no_interactive_session_reported" : accessible && interactive ? "input_desktop_reported_accessible"
        : state === "not_ready" ? "input_desktop_inaccessible" : "desktop_readiness_not_reported",
      "agent:/v1/desktop/session", finiteElapsed(started)), accessible, interactive,
      captureMayMissSecureDesktop: data.captureMayMissSecureDesktop === true };
  } catch {
    signal?.throwIfAborted();
    return { stage: stage("graphical_session", "interactive", "unknown",
      deadline.timedOut() ? "desktop_probe_expired" : "desktop_probe_failed",
      "agent:/v1/desktop/session", finiteElapsed(started)), accessible: false, interactive: false,
      captureMayMissSecureDesktop: null };
  } finally { deadline.dispose(); }
}

/** No side effects: inspect only selected endpoint capabilities and desktop session metadata. */
export async function diagnosticDoctor(client: AgentClient, requestedDevice: string,
  options: { probeTimeoutMs?: number; includeDesktop?: boolean } = {}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  const device = client.getDevice(requestedDevice).name;
  const configured = client.configuredContexts(device);
  const budgetMs = fleetProbeBudget(options.probeTimeoutMs);
  const includeDesktop = options.includeDesktop !== false;
  const allContexts: Array<[AgentEndpointContext, boolean]> = [
    ["system", configured.system], ["user", configured.user], ["desktop", configured.desktop],
  ];
  // Explicit interactive routes run independently. A Linux owner route shares
  // the owner probe's budget and uses its capability response to select the
  // session route without a duplicate request.
  const ownerStarted = performance.now();
  const pendingProbes = allContexts.map(async ([context, enabled]): Promise<Probe> =>
    enabled ? boundedInfo(client, device, context, budgetMs, signal) : {
      stage: stage("agent", identityFor(context), "not_configured", "endpoint_not_configured_no_request", "configuration"),
    });
  const noSession = (state: State, cause: string, source: string) => ({
    stage: stage("graphical_session", "interactive", state, cause, source),
    accessible: false, interactive: false, captureMayMissSecureDesktop: null as boolean | null,
  });
  const pendingSession = async () => {
    if (!includeDesktop) return noSession("not_configured", "desktop_probe_not_requested", "configuration");
    if (configured.desktop) return boundedDesktop(client, device, budgetMs, signal);
    if (!configured.user) return noSession("not_configured", "interactive_endpoint_not_configured", "configuration");
    const owner = await pendingProbes[1]!;
    if (!owner.info) return noSession("unknown", "owner_desktop_capability_unavailable", "agent:/v1/info");
    if (!client.supportsLinuxOwnerDesktop(owner.info))
      return noSession("not_configured", "interactive_endpoint_not_configured", "configuration");
    const remainingMs = Math.floor(budgetMs - (performance.now() - ownerStarted));
    return remainingMs > 0 ? boundedDesktop(client, device, remainingMs, signal, owner.info)
      : noSession("unknown", "desktop_probe_expired", "agent:/v1/desktop/session");
  };
  const [probes, session] = await Promise.all([Promise.all(pendingProbes), pendingSession()]);
  signal?.throwIfAborted();

  const primary = probes[0]!.stage;
  const owner = probes[1]!.stage;
  const desktopCapability: Stage = includeDesktop && session.stage.state === "ready"
    ? stage("input_capability", "interactive", "responded", "input_desktop_accessible_no_input_generated",
      "agent:/v1/desktop/session")
    : stage("input_capability", "interactive", "unknown", "input_not_qualified_no_input_generated", "configuration");
  const captureCapability: Stage = includeDesktop && session.stage.state === "ready"
    ? stage("capture_capability", "interactive", "responded",
      session.captureMayMissSecureDesktop ? "capture_secure_desktop_boundary_reported" : "capture_not_exercised",
      "agent:/v1/desktop/session")
    : stage("capture_capability", "interactive", "unknown", "capture_not_qualified_no_image_taken", "configuration");
  const desktopRuntime = includeDesktop ? probes[configured.desktop ? 2 : 1]?.info?.runtime : undefined;
  const runtime = desktopRuntime && typeof desktopRuntime === "object" ? desktopRuntime as Record<string, unknown> : {};
  const advertisedCapabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : [];
  const engine = advertisedCapabilities.includes("desktop-semantic-v1")
    ? stage("managed_desktop_engine", "interactive", "responded",
      "semantic_desktop_capability_reported_native_engine_not_verified", "agent:/v1/info")
    : stage("managed_desktop_engine", "interactive", "unknown",
      "no_verified_engine_identity_in_this_diagnostic", "separate_engine_status");
  const stages = [stage("controller", null, "ready", "tool_handler_active", "controller"),
    ...probes.map(p => p.stage), session.stage, engine, captureCapability, desktopCapability];
  const desktopReady = !includeDesktop ||
    (configured.desktop ? probes[2]!.stage.state === "ready" && session.stage.state === "ready"
      : session.stage.state === "not_configured" || session.stage.state === "ready");
  const state: "ready" | "partial" | "unknown" = primary.state === "unknown" ? "unknown"
    : primary.state === "ready" && owner.state === "ready" && desktopReady ? "ready" : "partial";
  const nextCheck = primary.state === "unknown" ? "Check system agent reachability; physical power state is unverified."
    : owner.state === "not_configured" ? "Configure an owner endpoint only if owner operations are required."
    : owner.state === "unknown" ? "Inspect the owner agent independently; do not infer a system outage."
    : includeDesktop && session.stage.state === "not_configured" ? "Desktop was not configured; shell and file operations may still work."
    : includeDesktop && !desktopReady ? "Inspect interactive agent and session prerequisites; no desktop action was attempted."
    : "Readiness is observed; use a separately authorized synthetic action to verify effects.";
  return {
    version: 1 as const, device, requestedDevice, observedAt: new Date().toISOString(),
    elapsedMs: finiteElapsed(started), probeBudgetMs: budgetMs, budgetScope: "per_endpoint",
    status: state, configured, stages, nextCheck,
    coverage: { readonly: true, inputGenerated: false, captureTaken: false,
      physicalPowerVerified: false, processEffectsVerified: false,
      caveat: "Controller and bearer observations are not proof of origin, physical power or execution effects." },
  };
}

export const diagnosticDoctorOutputSchema = z.object({
  version: z.literal(1), device: z.string(), requestedDevice: z.string(),
  observedAt: z.string(), elapsedMs: z.number().nonnegative(),
  probeBudgetMs: z.number().int().positive(), budgetScope: z.literal("per_endpoint"),
  status: z.enum(["ready", "partial", "unknown"]),
  configured: z.object({ system: z.boolean(), user: z.boolean(), desktop: z.boolean() }),
  stages: z.array(z.object({
    name: z.string(), identity: z.enum(["root", "owner", "interactive"]).nullable(),
    state: z.enum(["ready", "responded", "not_ready", "unavailable", "unknown", "not_configured"]),
    cause: z.string(), source: z.string(), observedAt: z.string(), elapsedMs: z.number().nonnegative().nullable(),
  })), nextCheck: z.string(),
  coverage: z.object({ readonly: z.literal(true), inputGenerated: z.literal(false), captureTaken: z.literal(false),
    physicalPowerVerified: z.literal(false), processEffectsVerified: z.literal(false), caveat: z.string() }),
});

export function registerDiagnosticDoctor(server: McpServer, client: AgentClient) {
  server.registerTool("diagnostic_doctor", {
    description: "Read-only bounded diagnostic for one device: controller, root/owner/interactive agents, graphical session and reported capture/input limits. Never clicks, captures or remediates. Separates unavailable owner from system connectivity and does not infer host power state.",
    inputSchema: z.object({
      device: z.string().min(1),
      probeTimeoutMs: z.number().int().min(100).max(5000).optional(),
      includeDesktop: z.boolean().optional(),
    }).strict(),
    outputSchema: diagnosticDoctorOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ device, probeTimeoutMs, includeDesktop }, extra) => {
    const result = await diagnosticDoctor(client, device, { probeTimeoutMs, includeDesktop }, extra.signal);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
  });
}
