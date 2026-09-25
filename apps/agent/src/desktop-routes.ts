import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { desktopRequest } from "./desktop-sequence.ts";
import { desktopFocusSchema as focusSchema, desktopMouseSchema as mouseSchema, desktopKeyboardSchema as keyboardSchema, desktopUiaSchema, desktopWindowsFields, desktopBatchSchema as batchSchema } from "../../../packages/protocol/src/desktop.ts";
import { closeDesktopHelper, desktopUia, desktopBatch, desktopBrowserOpen, desktopClipboardGet, desktopClipboardSet, desktopFocus, desktopHelperStatus, desktopKeyboard, desktopLaunch, desktopMonitors, desktopMouse, desktopScreenshot, desktopSessionStatus, desktopWindows } from "./desktop.ts";

const screenshotSchema = z.object({ monitor: z.union([z.number().int().nonnegative(), z.literal("all")]).optional(), scale: z.number().positive().max(1).optional() });
const clipboardSchema = z.object({ text: z.string() });
const launchSchema = z.object({ target: z.string().min(1), arguments: z.array(z.string()).optional(), waitForWindowMs: z.number().int().min(0).max(10_000).optional(), requireWindow: z.boolean().optional() });
const browserSchema = z.object({ url: z.string().url(), browser: z.enum(["auto", "edge", "chrome", "brave", "firefox"]).optional(), newWindow: z.boolean().optional() });

export function registerDesktopRoutes(app: FastifyInstance): void {
  app.addHook("onClose", async () => closeDesktopHelper());
  app.get("/v1/desktop/monitors", desktopRequest(async () => desktopMonitors()));
  app.get("/v1/desktop/windows", desktopRequest(async () => desktopWindows()));
  app.post("/v1/desktop/windows", desktopRequest(async (request, reply) => { const p=z.object(desktopWindowsFields).safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopWindows(p.data); }));
  app.post("/v1/desktop/uia", desktopRequest(async (request, reply) => { const p=desktopUiaSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopUia(p.data); }));
  app.get("/v1/desktop/session", desktopRequest(async () => desktopSessionStatus()));
  app.get("/v1/desktop/helper/status", desktopRequest(async () => desktopHelperStatus()));
  app.post("/v1/desktop/screenshot", desktopRequest(async (request, reply) => { const p=screenshotSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopScreenshot(p.data); }));
  app.post("/v1/desktop/focus", desktopRequest(async (request, reply) => { const p=focusSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopFocus(p.data); }));
  app.post("/v1/desktop/mouse", desktopRequest(async (request, reply) => { const p=mouseSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopMouse(p.data); }));
  app.post("/v1/desktop/keyboard", desktopRequest(async (request, reply) => { const p=keyboardSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopKeyboard(p.data); }));
  app.get("/v1/desktop/clipboard", desktopRequest(async () => desktopClipboardGet()));
  app.post("/v1/desktop/clipboard", desktopRequest(async (request, reply) => { const p=clipboardSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopClipboardSet(p.data); }));
  app.post("/v1/desktop/launch", desktopRequest(async (request, reply) => { const p=launchSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopLaunch(p.data); }));
  app.post("/v1/desktop/browser/open", desktopRequest(async (request, reply) => { const p=browserSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopBrowserOpen(p.data); }));
  app.post("/v1/desktop/batch", desktopRequest(async (request, reply) => { const p=batchSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return desktopBatch(p.data); }));
}
