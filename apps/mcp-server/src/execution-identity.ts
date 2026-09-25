import { z } from "zod";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";

export type ExecutionIdentity = "auto" | "owner" | "root" | "interactive";
export type ElevationMode = "auto" | "never" | "root";
export type LegacyContext = "system" | "user";

export const identitySchema = z.enum(["auto", "owner", "root", "interactive"]).optional().describe(
  "Canonical execution selector. owner->user, root->system, interactive->desktop. A non-auto identity takes precedence over the legacy context alias.",
);
export const elevationSchema = z.enum(["auto", "never", "root"]).optional().describe(
  "Elevation intent. root requires root identity/system context; never forbids root. Omit or use auto unless elevation is intentional.",
);
export const legacyContextSchema = z.enum(["system", "user"]).optional().describe(
  "Legacy routing alias used when identity is omitted or auto. Prefer identity for new calls.",
);

/**
 * Strict input schema shared by execution-aware tools.
 * Keeping a top-level object is deliberate: the MCP SDK currently publishes a
 * top-level Zod union as an empty JSON schema, while nested unions serialize.
 */
export function executionInputSchema<const T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...shape,
    identity: identitySchema,
    context: legacyContextSchema,
    elevation: elevationSchema,
  }).strict();
}

function identityToContext(identity: Exclude<ExecutionIdentity, "auto">): AgentEndpointContext {
  if (identity === "root") return "system";
  if (identity === "owner") return "user";
  return "desktop";
}

function contextIdentity(context: AgentEndpointContext): Exclude<ExecutionIdentity, "auto"> {
  if (context === "system") return "root";
  if (context === "user") return "owner";
  return "interactive";
}

export function resolveExecutionContext(
  client: AgentClient,
  device: string,
  input: { identity?: ExecutionIdentity; elevation?: ElevationMode; context?: LegacyContext },
  autoDefault: AgentEndpointContext,
): AgentEndpointContext {
  const explicitIdentity = input.identity && input.identity !== "auto" ? input.identity : undefined;
  const legacyIdentity = input.context === "system" ? "root" : input.context === "user" ? "owner" : undefined;

  // identity is canonical. A stale/conflicting legacy context is intentionally
  // ignored when the caller supplied an explicit identity.
  if (input.elevation === "root" && explicitIdentity && explicitIdentity !== "root") {
    throw new Error(`Conflicting elevation=root and identity=${explicitIdentity}; use identity=root or elevation=auto.`);
  }
  if (input.elevation === "never" && explicitIdentity === "root") {
    throw new Error("Conflicting elevation=never and identity=root; use identity=owner or elevation=auto.");
  }
  if (!explicitIdentity && input.elevation === "root" && legacyIdentity === "owner") {
    throw new Error("Conflicting elevation=root and context=user; use identity=root/context=system or omit elevation.");
  }
  if (!explicitIdentity && input.elevation === "never" && legacyIdentity === "root") {
    throw new Error("Conflicting elevation=never and context=system; use context=user/identity=owner or elevation=auto.");
  }

  let resolved: AgentEndpointContext;
  if (explicitIdentity) resolved = identityToContext(explicitIdentity);
  else if (input.elevation === "root") resolved = "system";
  else if (legacyIdentity) resolved = identityToContext(legacyIdentity);
  else if (input.elevation === "never") resolved = "user";
  else resolved = autoDefault;

  const configured = client.configuredContexts(device);
  // Android reverse control intentionally exposes only the owner/user
  // capability. Auto routing may use it when no system endpoint exists, but
  // an explicit root/system request must remain an error.
  const autoRequested = !explicitIdentity && input.elevation !== "root" && !legacyIdentity;
  if (autoRequested && resolved === "system" && !configured.system && configured.user) resolved = "user";
  if (resolved === "user" && !configured.user) throw new Error(`${device} owner identity is not configured`);
  if (resolved === "system" && !configured.system) throw new Error(`${device} system/root identity is not configured`);
  if (resolved === "desktop" && !configured.desktop) throw new Error(`${device} interactive identity is not configured`);
  return resolved;
}

export function executionLabel(context: AgentEndpointContext) {
  return contextIdentity(context);
}
