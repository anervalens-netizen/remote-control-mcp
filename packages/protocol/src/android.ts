import { z } from "zod";

export const androidStateSchema = z.object({
  androidSdk: z.number().int().nonnegative(),
  manufacturer: z.string().min(1),
  model: z.string().min(1),
  build: z.string().min(1),
  appVersion: z.string().min(1),
  uid: z.number().int().nonnegative(),
  screenOn: z.boolean(),
  keyguardLocked: z.boolean(),
  userUnlocked: z.boolean(),
  accessibility: z.boolean(),
  paused: z.boolean(),
  controlGeneration: z.number().int().nonnegative().max(2_147_483_647).optional().default(0),
  shellAvailable: z.boolean(),
  network: z.string().min(1),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
}).strict();

const uuid = z.string().uuid();
const snapshotId = uuid;
const nodeId = z.string().min(1).max(4000)
  .regex(/^0(?:\/(?:0|[1-9]\d{0,2}))*$/)
  .refine((value) => value.split("/").length <= 1000, "nodeId exceeds maximum observed-tree depth");

export const androidObserveRequestSchema = z.object({
  operation: z.literal("observe"),
  image: z.boolean().optional().default(true),
  tree: z.boolean().optional().default(true),
  maxNodes: z.number().int().min(1).max(1000).optional().default(200),
}).strict();

export const androidTapRequestSchema = z.object({
  operation: z.literal("tap"), snapshotId, x: z.number(), y: z.number(),
}).strict();
export const androidSwipeRequestSchema = z.object({
  operation: z.literal("swipe"), snapshotId, fromX: z.number(), fromY: z.number(),
  toX: z.number(), toY: z.number(), durationMs: z.number().int().min(50).max(5000).optional().default(300),
}).strict();
export const androidSetTextRequestSchema = z.object({
  operation: z.literal("set_text"), snapshotId, nodeId, text: z.string().max(1024 * 1024),
}).strict();
export const androidNodeActionRequestSchema = z.object({
  operation: z.literal("node_action"), snapshotId, nodeId,
  action: z.enum(["click", "long_click", "scroll_forward", "scroll_backward", "focus"]),
}).strict();
export const androidGlobalActionRequestSchema = z.object({
  operation: z.literal("global_action"),
  action: z.enum(["home", "back", "recents", "notifications", "quick_settings", "lock_screen"]),
}).strict();
export const androidOpenAppRequestSchema = z.object({
  operation: z.literal("open_app"), packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
}).strict();
export const androidShellRequestSchema = z.object({
  operation: z.literal("shell"),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(600_000).optional().default(120_000),
  maxOutputBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional().default(1024 * 1024),
}).strict();

export const androidCommandRequestSchema = z.discriminatedUnion("operation", [
  androidObserveRequestSchema,
  androidTapRequestSchema,
  androidSwipeRequestSchema,
  androidSetTextRequestSchema,
  androidNodeActionRequestSchema,
  androidGlobalActionRequestSchema,
  androidOpenAppRequestSchema,
  androidShellRequestSchema,
]);
export type AndroidCommandRequest = z.infer<typeof androidCommandRequestSchema>;

export const androidPollRequestSchema = z.object({
  version: z.literal(1), device: z.string().min(1), sessionId: uuid, state: androidStateSchema,
}).strict();

export const androidCommandEnvelopeSchema = z.object({
  commandId: uuid, deliveryId: uuid, expiresAt: z.number().int().positive(), request: androidCommandRequestSchema,
}).strict();
export const androidPollResponseSchema = z.object({
  version: z.literal(1), serverTime: z.number().int().positive(), serverWaitMs: z.number().int().nonnegative(),
  command: androidCommandEnvelopeSchema.nullable(),
}).strict();

const androidErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
export const androidResultRequestSchema = z.object({
  version: z.literal(1), device: z.string().min(1), sessionId: uuid, commandId: uuid, deliveryId: uuid,
  ok: z.boolean(),
  status: z.enum(["completed", "error", "outcome_unknown"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: androidErrorSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.ok && value.status !== "completed") ctx.addIssue({ code: "custom", message: "ok results must use status completed", path: ["status"] });
  if (!value.ok && value.status === "completed") ctx.addIssue({ code: "custom", message: "failed results cannot use status completed", path: ["status"] });
  if (!value.ok && !value.error) ctx.addIssue({ code: "custom", message: "failed results require error", path: ["error"] });
  if (value.ok && value.error) ctx.addIssue({ code: "custom", message: "successful results cannot include error", path: ["error"] });
});
export const androidResultResponseSchema = z.object({ version: z.literal(1), accepted: z.literal(true) }).strict();

export type AndroidPollRequest = z.infer<typeof androidPollRequestSchema>;
export type AndroidPollResponse = z.infer<typeof androidPollResponseSchema>;
export type AndroidResultRequest = z.infer<typeof androidResultRequestSchema>;

export const androidSnapshotSchema = z.object({
  snapshotId: uuid, observedAt: z.number().int().positive(), width: z.number().int().positive(),
  height: z.number().int().positive(), rotation: z.number().int(), generation: z.string().min(1),
}).strict();
export const androidImageSchema = z.union([
  z.object({ available: z.literal(true), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  z.object({ available: z.literal(false), reason: z.string().min(1) }).strict(),
]);

export const androidUiNodeSchema = z.object({
  nodeId,
  text: z.string(),
  description: z.string(),
  viewId: z.string(),
  className: z.string(),
  packageName: z.string(),
  clickable: z.boolean(),
  editable: z.boolean(),
  bounds: z.object({
    left: z.number().int(), top: z.number().int(), right: z.number().int(), bottom: z.number().int(),
  }).strict(),
}).strict();
