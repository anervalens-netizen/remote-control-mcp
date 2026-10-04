import { z } from "zod";
export const coordinationTokenSchema = z.object({
  resourceId: z.string().regex(/^[a-f0-9]{64}$/), operationId: z.string().uuid(),
  generation: z.number().int().positive(), baseVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const coordinationFields = { coordination: coordinationTokenSchema.optional() };
export const coordinationResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repo"), path: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("service"), name: z.string().min(1).max(256), scope: z.enum(["user", "system"]).optional() }).strict(),
]);
export const coordinationRequestSchema = z.object({
  resource: coordinationResourceSchema, action: z.enum(["inspect", "acquire", "release"]),
  token: coordinationTokenSchema.optional(), leaseMs: z.number().int().min(100).max(300_000).optional(),
  ownerOverride: z.object({ expectedGeneration: z.number().int().nonnegative(), expectedBaseVersion: z.string().regex(/^[a-f0-9]{64}$/), reason: z.enum(["abandoned_reservation", "owner_takeover"]) }).strict().optional(),
}).strict();
export type CoordinationToken = z.infer<typeof coordinationTokenSchema>;
export type CoordinationResource = z.infer<typeof coordinationResourceSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const coordinationRecordSchema = coordinationTokenSchema.extend({
  version: z.literal(1), budgetSlot: z.number().int().min(0).max(3), device: hash, identity: hash, canonicalKey: hash,
  state: z.enum(["reserved", "active", "released", "uncertain"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.number(),
  instanceId: z.string().uuid(), jobId: z.string().uuid().optional(), conflictReason: z.string().max(80).nullable(),
  overrides: z.array(z.object({ operationId: z.string().uuid(), previousOperationId: z.string().uuid(), at: z.string().datetime(), reason: z.enum(["abandoned_reservation", "owner_takeover"]) })).max(32),
}).strict();
export type CoordinationRecord = z.infer<typeof coordinationRecordSchema>;

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
