import { z } from "zod";

export const desktopRef = z.string().regex(/^@[A-Za-z0-9_-]+:e\d+$/);
export const semanticObserveSchema = z.object({
  kind: z.enum(["status", "apps", "windows", "snapshot", "get"]).default("snapshot"),
  app: z.string().min(1).max(512).optional(),
  windowId: z.string().min(1).max(512).optional(),
  surface: z.enum(["window", "focused", "sheet", "menu", "alert", "taskbar", "start-menu", "system-tray", "action-center"]).optional(),
  skeleton: z.boolean().default(true),
  interactiveOnly: z.boolean().default(true),
  maxDepth: z.number().int().min(1).max(30).default(10),
  timeoutMs: z.number().int().min(100).max(20000).default(5000),
  observationId: z.uuid().optional(),
  ref: desktopRef.optional(),
  property: z.enum(["text", "value", "title", "bounds", "role", "states"]).default("text"),
}).strict();
export const semanticActSchema = z.object({
  commandId: z.uuid(),
  mode: z.enum(["execute", "status"]).default("execute"),
  observationId: z.uuid().optional(),
  ref: desktopRef.optional(),
  action: z.enum(["click", "right-click", "set-value", "type", "clear", "select", "check", "uncheck", "toggle", "expand", "collapse", "scroll-to", "focus"]).optional(),
  value: z.string().max(65536).optional(),
  headed: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(20000).default(5000),
  observeAfter: z.boolean().default(true),
}).strict();
export type SemanticObserve = z.infer<typeof semanticObserveSchema>;
export type SemanticAct = z.infer<typeof semanticActSchema>;
export const semanticManifestSchema = z.object({
  version: z.literal(1),
  engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  jsonVersion: z.literal("2.5"),
  binary: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
  upstreamCommit: z.string().optional(),
  archiveSha256: z.string().optional(),
  provenanceVerified: z.boolean().default(false),
}).strict();
export type SemanticManifest = z.infer<typeof semanticManifestSchema>;
