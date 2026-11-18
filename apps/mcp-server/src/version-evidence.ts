import { constants, lstatSync, readFileSync, openSync, closeSync, fstatSync } from "node:fs";
import { z } from "zod";
import path from "node:path";

const shaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const declaration = z.object({
  desiredSha: shaSchema.optional(),
  installedSha: shaSchema.optional(),
  startupTargetSha: shaSchema.optional(),
  recordedAt: z.iso.datetime(),
}).strict();
const deviceEntry = z.object({
  role: z.enum(["primary", "backup", "intermittent", "retired", "test"]).optional(),
  root: declaration.optional(),
  owner: declaration.optional(),
  interactive: declaration.optional(),
}).strict();
const inventorySchema = z.object({
  version: z.literal(1),
  devices: z.record(z.string().min(1).max(128), deviceEntry)
    .refine(devices => Object.keys(devices).length <= 64),
}).strict();
export type VersionInventory = z.infer<typeof inventorySchema>;
export type VersionInventoryRead = {
  state: "unconfigured" | "invalid" | "valid";
  value: VersionInventory | null;
};
const maxBytes = 64 * 1024;

/** Owner-provided SHA declarations are not proof of a live installed file or
 * startup unit. This reader never publishes a path, raw data, or parse error. */
export function readVersionInventory(file = process.env.RCMCP_VERSION_EVIDENCE_FILE): VersionInventoryRead {
  if (!file) return { state: "unconfigured", value: null };
  try {
    if (!path.isAbsolute(file)) throw Error("invalid");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw Error("invalid");
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.size > maxBytes) throw Error("invalid");
      bytes = readFileSync(fd);
      if (bytes.length > maxBytes || bytes.length !== current.size) throw Error("invalid");
    } finally { closeSync(fd); }
    return { state: "valid", value: inventorySchema.parse(JSON.parse(bytes.toString("utf8"))) };
  } catch {
    return { state: "invalid", value: null };
  }
}

type Identity = "root" | "owner" | "interactive";
const compare = (a: string | null, b: string | null) =>
  a === null || b === null ? "unknown" as const : a === b ? "match" as const : "mismatch" as const;

export function endpointVersionEvidence(
  endpoint: { ok: true; info: unknown } | { ok: false; error: string },
  inventory: VersionInventoryRead, device: string, identity: Identity,
) {
  const info = endpoint.ok && endpoint.info && typeof endpoint.info === "object" ? endpoint.info as Record<string, unknown> : {};
  const runtimeValue = info.runtime;
  const runtime = runtimeValue && typeof runtimeValue === "object" ? runtimeValue as Record<string, unknown> : {};
  const releaseValue = runtime.releaseIdentity;
  const release = releaseValue && typeof releaseValue === "object" ? releaseValue as Record<string, unknown> : {};
  const releaseInfo = release.release && typeof release.release === "object" ? release.release as Record<string, unknown> : {};
  const validation = typeof releaseInfo.validation === "string" &&
    ["pinned_integrity", "integrity_only", "rejected", "unavailable"].includes(releaseInfo.validation)
      ? releaseInfo.validation : null;
  const runningSha = typeof runtime.sha === "string" && shaSchema.safeParse(runtime.sha).success ? runtime.sha : null;
  const entry = inventory.value?.devices[device];
  const claims = entry?.[identity];
  const declared = (key: "desiredSha" | "installedSha" | "startupTargetSha") => ({
    sha: claims?.[key] ?? null,
    provenance: claims?.[key] ? "operator_declaration" as const : "unavailable" as const,
    declaredAt: claims?.[key] ? claims.recordedAt : null,
    independentlyVerified: false,
  });
  const desired = declared("desiredSha");
  const installed = declared("installedSha");
  const startupTarget = declared("startupTargetSha");
  const running = {
    sha: runningSha,
    provenance: endpoint.ok ? "agent_runtime" as const : "unavailable" as const,
    validation, observedAt: endpoint.ok ? new Date().toISOString() : null,
    locallyPinnedAtStartup: validation === "pinned_integrity" &&
      release.shaBinding === "pinned_manifest" && runningSha !== null && release.sha === runningSha,
    independentlyVerified: false,
    upstreamVerified: false,
  };
  return {
    desired, installed, startupTarget, running,
    comparisons: {
      desiredToRunning: compare(desired.sha, running.sha),
      installedToRunning: compare(installed.sha, running.sha),
      startupTargetToRunning: compare(startupTarget.sha, running.sha),
      comparisonScope: "declared_sha_vs_agent_runtime" as const,
    },
    inventory: {
      state: inventory.state,
      role: entry?.role ?? "unknown",
      expectedAvailabilityHint: entry?.role === "retired" ? "retired_should_not_be_continuous" : null,
      source: inventory.state === "valid" ? "operator_declaration" as const : "unavailable" as const,
    },
    limitations: "Desired, installed and startup targets are operator declarations, not live service-manager inspections. SHA equality is not proof of restart persistence, provenance or application effects.",
  };
}
