import { z } from "zod";
export const desktopWindowsFields = { includeHidden: z.boolean().optional(), pid: z.number().int().positive().optional(), title: z.string().optional() };
export type DesktopWindowsInput = z.infer<z.ZodObject<typeof desktopWindowsFields>>;

export const desktopUiaFields = {
  action: z.enum(["query", "inspect", "focus", "invoke", "setValue", "select", "toggle", "expand", "collapse", "pattern"]).optional(),
  handle: z.number().int().positive().optional(), elementId: z.string().min(1).optional(),
  name: z.string().optional(), automationId: z.string().optional(), controlType: z.string().optional(),
  depth: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().optional(),
  textLimit: z.number().int().min(-1).optional(), value: z.string().optional(),
  pattern: z.string().min(1).optional(), method: z.string().min(1).optional(), arguments: z.array(z.unknown()).optional(),
};
export const desktopUiaSchema = z.object(desktopUiaFields).superRefine((v, ctx) => {
  if (v.action === "setValue" && v.value === undefined) ctx.addIssue({ code: "custom", message: "value is required for setValue" });
  if (v.action === "pattern" && (!v.pattern || !v.method)) ctx.addIssue({ code: "custom", message: "pattern and method are required" });
  if (v.action && v.action !== "query" && !v.handle && !v.elementId) ctx.addIssue({ code: "custom", message: "handle or elementId is required for this action" });
});
export type DesktopUiaInput = z.infer<typeof desktopUiaSchema>;


export const desktopFocusSchema = z.object({
  handle: z.number().int().positive().optional(), pid: z.number().int().positive().optional(), title: z.string().min(1).optional(),
}).strict().refine(v => v.handle !== undefined || v.pid !== undefined || v.title !== undefined, "handle, pid or title is required");
export const desktopMouseSchema = z.object({
  action: z.enum(["position", "move", "click", "doubleClick", "scroll"]),
  x: z.number().int().optional(), y: z.number().int().optional(),
  button: z.enum(["left", "right", "middle"]).optional(), delta: z.number().int().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action === "position" && [v.x, v.y, v.button, v.delta].some(x => x !== undefined)) ctx.addIssue({code:"custom",message:"position is read-only; omit coordinates, button and delta"});
  if ((v.x === undefined) !== (v.y === undefined)) ctx.addIssue({code:"custom",message:"x and y must be supplied together"});
  if (v.action === "move" && v.x === undefined) ctx.addIssue({code:"custom",message:"move requires x and y"});
  if (v.button !== undefined && v.action !== "click" && v.action !== "doubleClick") ctx.addIssue({code:"custom",message:"button is only valid for click/doubleClick"});
  if (v.delta !== undefined && v.action !== "scroll") ctx.addIssue({code:"custom",message:"delta is only valid for scroll"});
});
export const desktopKeyboardSchema = z.object({
  action: z.enum(["type", "press", "hotkey"]), text: z.string().optional(), keys: z.array(z.string().min(1)).min(1).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.action === "type") {
    if (v.text === undefined) ctx.addIssue({code:"custom",message:"text is required for type"});
    if (v.keys !== undefined) ctx.addIssue({code:"custom",message:"keys are not valid for type"});
  } else {
    if (!v.keys?.length) ctx.addIssue({code:"custom",message:"keys are required for press/hotkey"});
    if (v.text !== undefined) ctx.addIssue({code:"custom",message:"text is only valid for type"});
  }
});

export const desktopBatchActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("monitors") }),
  z.object({ kind: z.literal("windows"), ...desktopWindowsFields }),
  z.object({ kind: z.literal("session") }),
  desktopUiaSchema.safeExtend({ kind: z.literal("uia") }),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(0).max(2_147_483_647) }),
  desktopFocusSchema.safeExtend({ kind: z.literal("focus") }),
  desktopMouseSchema.safeExtend({ kind: z.literal("mouse") }),
  desktopKeyboardSchema.safeExtend({ kind: z.literal("keyboard") }),
  z.object({ kind: z.literal("screenshot"), monitor: z.union([z.number().int().nonnegative(), z.literal("all")]).optional(), scale: z.number().positive().max(1).optional() }),
  z.object({ kind: z.literal("browser"), url: z.string().url(), browser: z.enum(["auto", "edge", "chrome", "brave", "firefox"]).optional(), newWindow: z.boolean().optional() }),
  z.object({ kind: z.literal("clipboardGet") }),
  z.object({ kind: z.literal("clipboardSet"), text: z.string() }),
  z.object({ kind: z.literal("launch"), target: z.string().min(1), arguments: z.array(z.string()).optional(), waitForWindowMs: z.number().int().min(0).max(10_000).optional(), requireWindow: z.boolean().optional() }),
]);

export const desktopBatchSchema = z.object({ actions: z.array(desktopBatchActionSchema).min(1), stopOnError: z.boolean().optional() });
export type DesktopBatchAction = z.infer<typeof desktopBatchActionSchema>;
export type DesktopBatchInput = z.infer<typeof desktopBatchSchema>;
