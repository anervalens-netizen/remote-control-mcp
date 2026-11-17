import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const coordinationTokenSchema = z.object({
  resourceId: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid(),
  generation: z.number().int().positive(), baseVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const coordinationFields = { coordination: coordinationTokenSchema.optional() };
// A sanitized, four-slot diagnostic. No raw resource path, token, operation ID,
// job ID or credential crosses this contract. State is not effect/exit proof.
export const coordinationCapacitySlotSchema = z.object({
  slot: z.number().int().min(0).max(3),
  state: z.enum(["free", "reserved", "active", "uncertain", "released", "orphan", "unreadable"]),
  identityScope: z.enum(["same", "other", "unknown"]),
  ageBand: z.enum(["under_hour", "under_day", "over_day", "unknown"]),
  lease: z.enum(["valid", "elapsed", "unknown"]),
  jobEvidence: z.enum(["no_binding", "bound_unverified", "disposition_recorded", "unavailable"]),
}).strict();
export const coordinationCapacitySnapshotSchema = z.object({
  version: z.literal(1), observedAt: z.string().datetime(),
  budget: z.number().int().min(1).max(4),
  freeSlots: z.number().int().min(0).max(4),
  occupiedSlots: z.number().int().min(0).max(4),
  visibility: z.enum(["complete", "partial"]),
  noAutoRelease: z.literal(true), snapshotConsistency: z.literal("non_atomic"),
  slots: z.array(coordinationCapacitySlotSchema).min(1).max(4),
}).strict();
export const coordinationResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("service"), name: z.string().min(1).max(256), scope: z.enum(["user", "system"]).optional() }).strict(),
]);
export const coordinationRequestSchema = z.object({
  resource: coordinationResourceSchema, action: z.enum(["inspect", "inspect_recovery", "acquire", "release", "prepare_recovery", "reconcile"]),
  token: coordinationTokenSchema.optional(), leaseMs: z.number().int().min(100).max(300_000).optional(),
  ownerOverride: z.object({ expectedGeneration: z.number().int().nonnegative(), expectedBaseVersion: z.string().regex(/^[a-f0-9]{64}$/), reason: z.enum(["abandoned_reservation", "owner_takeover"]) }).strict().optional(),
  expectedCurrentBaseVersion: hash.optional(), recoveryIntentId: hash.optional(),
}).strict();
export type CoordinationToken = z.infer<typeof coordinationTokenSchema>;
export type CoordinationResource = z.infer<typeof coordinationResourceSchema>;

export const coordinationExecutionSchema = z.object({
  kind: z.literal("repo_job"), key: z.string().min(1).max(200), fingerprint: hash, requestHash: hash,
}).strict();
export const coordinationResolutionSchema = z.object({
  kind: z.enum(["durable_job", "boot_transition"]), at: z.string().datetime(),
  originalRecordHash: hash, originalJournalHash: hash, observedBaseVersion: hash, evidenceHash: hash,
  jobId: z.string().uuid().optional(), recoveryIntentId: hash.optional(),
  preparedBaseVersion: hash.optional(),
  outcome: z.enum(["completed", "cancelled", "unknown"]),
  effectVerification: z.literal("unverified"), noReplay: z.literal(true),
}).strict();
export const coordinationRecoveryIntentSchema = z.object({
  version: z.literal(1), id: hash, token: coordinationTokenSchema,
  device: hash, identity: hash, canonicalKey: hash, originalRecordHash: hash, originalJournalHash: hash,
  observedBaseVersion: hash, bootIdentity: z.string().regex(/^linux:[a-f0-9-]{36}$/),
  createdAt: z.string().datetime(), noReplay: z.literal(true),
}).strict();
export const coordinationRecordSchema = coordinationTokenSchema.extend({
  version: z.literal(1), budgetSlot: z.number().int().min(0).max(3), device: hash, identity: hash, canonicalKey: hash,
  state: z.enum(["reserved", "active", "released", "uncertain"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.number(),
  instanceId: z.string().uuid(), jobId: z.string().uuid().optional(), conflictReason: z.string().max(80).nullable(),
  overrides: z.array(z.object({ operationId: z.string().uuid(), previousOperationId: z.string().uuid(), at: z.string().datetime(), reason: z.enum(["abandoned_reservation", "owner_takeover"]) })).max(32),
}).strict();
export type CoordinationRecord = z.infer<typeof coordinationRecordSchema>;
/** Recovery metadata is a sidecar; the v1 disk journal and legacy wire record stay unchanged. */
export const coordinationRecoveryViewSchema = z.object({ execution: coordinationExecutionSchema.nullable(), resolution: coordinationResolutionSchema.nullable() }).strict();
export const coordinationRecordViewSchema = coordinationRecordSchema.extend({ execution: coordinationExecutionSchema.optional(), resolution: coordinationResolutionSchema.optional() });
export type CoordinationRecordView = z.infer<typeof coordinationRecordViewSchema>;
export type CoordinationExecution = z.infer<typeof coordinationExecutionSchema>;
export type CoordinationResolution = z.infer<typeof coordinationResolutionSchema>;
export type CoordinationRecoveryIntent = z.infer<typeof coordinationRecoveryIntentSchema>;

/** Exemptions mirror only flags supported by each route's execution schema. */
export function isCoordinationReadOnly(route: string, input: Record<string, unknown>): boolean {
  if (route === "/v1/service") return input.action === "status";
  if (route === "/v1/repo/apply-patch") return input.checkOnly === true;
  return ["/v1/repo/checkpoint", "/v1/repo/push", "/v1/project/run", "/v1/deploy/run"].includes(route) && input.dryRun === true;
}

export function isCoordinationRoute(route: string): boolean {
  return ["/v1/service", "/v1/deploy/run", "/v1/repo/checkpoint", "/v1/repo/apply-patch", "/v1/repo/fetch", "/v1/repo/pull", "/v1/repo/push", "/v1/project/run"].includes(route);
}

export function isCoordinatedWrite(route: string, body: unknown): boolean {
  if (!isCoordinationRoute(route)) return false;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const input = body as Record<string, unknown>;
  if (isCoordinationReadOnly(route, input)) return false;
  if (route === "/v1/service") return input.action !== "status";
  if (route === "/v1/deploy/run") return typeof (input.repoPath ?? input.cwd) === "string";
  return true;
}

export const coordinationConflictSchema = z.object({ reason: z.string().regex(/^[a-z_]{1,80}$/), coordination: coordinationRecordSchema.nullable() }).strict();
export type CoordinationConflict = z.infer<typeof coordinationConflictSchema>;
