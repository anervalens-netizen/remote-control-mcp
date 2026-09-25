import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { desktopFocusSchema, desktopMouseSchema, desktopKeyboardSchema, desktopUiaSchema, desktopWindowsFields, desktopBatchSchema } from "../../../packages/protocol/src/desktop.ts";
import type { AgentClient } from "./agent-client.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const structured = (value: Record<string, unknown>) => ({ ...text(value), structuredContent: value });
const desktopSessionOutput = {
  agentPid: z.number().int().positive().nullable(),
  agentSessionId: z.number().int().nonnegative().nullable(),
  activeConsoleSessionId: z.number().int().nonnegative().nullable(),
  interactiveSession: z.boolean(),
  inputDesktop: z.object({ accessible: z.boolean(), name: z.string().nullable(), error: z.number().int().nullable() }),
  consentProcesses: z.array(z.object({ pid: z.number().int().positive(), sessionId: z.number().int().nonnegative().nullable() })),
  secureDesktopLikely: z.boolean(),
  uacPromptPossible: z.boolean(),
  captureMayMissSecureDesktop: z.boolean(),
  captureBoundaryNote: z.string(),
};
type Screenshot = { data: string; mimeType: string; bytes: number; originX: number; originY: number; sourceWidth: number; sourceHeight: number; width: number; height: number; scale: number };

export function registerDesktopTools(server: McpServer, client: AgentClient): void {
  server.registerTool("desktop_monitors", {
    description: "List displays in the interactive desktop session, including global coordinates and primary monitor.",
    inputSchema: { device: z.string().min(1) },
  }, async ({ device }, extra) => text(await client.desktopMonitors(device, extra.signal)));

  server.registerTool("desktop_windows", {
    description: "Enumerate every top-level window, including secondary windows/dialogs from the same process. Always returns an array. Filter by pid/title; includeHidden exposes invisible windows.",
    inputSchema: { device: z.string().min(1), ...desktopWindowsFields },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device, ...input }, extra) => text(await client.desktopWindows(device, input, extra.signal)));

  server.registerTool("desktop_uia", {
    description: "Inspect and operate Windows UI Automation elements. Query a window handle (or desktop root), filter name/automationId/controlType, then use returned elementId to inspect/invoke/setValue/focus/select/toggle/expand/collapse. Query defaults depth 3, limit 100; offset/nextOffset page matches. Inspect lists pattern methods/typed arguments; action=pattern invokes any supported method. textLimit=-1 reads full exposed text. References bind process lifetime, window and runtime ID; they can resolve after helper restart or in one-shot mode. Requery stale elements.",
    inputSchema: { device: z.string().min(1), ...desktopUiaSchema.shape },
  }, async ({ device, ...input }, extra) => text(await client.desktopUia(device, desktopUiaSchema.parse(input), extra.signal)));

  server.registerTool("desktop_session_status", {
    description: "Inspect the interactive desktop session, current input desktop and UAC/Secure Desktop evidence without disabling Secure Desktop.",
    inputSchema: { device: z.string().min(1) },
    outputSchema: desktopSessionOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device }, extra) => structured(await client.desktopSessionStatus(device, extra.signal) as Record<string, unknown>));


  server.registerTool("desktop_helper_status", {
    description: "Inspect the persistent interactive PowerShell helper used by desktop actions.",
    inputSchema: { device: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device }, extra) => text(await client.desktopHelperStatus(device, extra.signal)));

  server.registerTool("desktop_batch", {
    description: "Execute an ordered desktop sequence in one call without interleaving other desktop actions. Returns per-action results and screenshot images; stops on failure by default. Completed actions are not rolled back or replayed.",
    inputSchema: {
      device: z.string().min(1),
      ...desktopBatchSchema.shape,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ device, actions, stopOnError }, extra) => {
    const result = await client.desktopBatch(device, { actions, stopOnError }, extra.signal) as { ok: boolean; results: Array<{ index: number; kind: string; result?: unknown }> };
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const results = result.results.map(item => {
      if (item.kind !== "screenshot" || !item.result || typeof item.result !== "object" || !("data" in item.result)) return item;
      const { data, mimeType, ...meta } = item.result as Screenshot;
      const imageIndex = images.length;
      images.push({ type: "image", data, mimeType });
      return { ...item, result: { ...meta, mimeType, imageIndex } };
    });
    return { isError: !result.ok, content: [...text({ ...result, results }).content, ...images] };
  });

  server.registerTool("desktop_screenshot", {
    description: "Capture a monitor or the full virtual desktop. Coordinates in metadata remain in original desktop pixels even when scaled.",
    inputSchema: { device: z.string().min(1), monitor: z.union([z.number().int().nonnegative(), z.literal("all")]).optional(), scale: z.number().positive().max(1).optional() },
  }, async ({ device, ...input }, extra) => {
    const shot = await client.desktopScreenshot(device, input, extra.signal) as Screenshot;
    const { data, mimeType, ...meta } = shot;
    return { content: [{ type: "text" as const, text: JSON.stringify(meta) }, { type: "image" as const, data, mimeType }] };
  });

  server.registerTool("desktop_focus", {
    description: "Restore and focus a desktop window by handle, PID or title substring.",
    inputSchema: desktopFocusSchema.safeExtend({ device: z.string().min(1) }),
  }, async ({ device, ...input }, extra) => text(await client.desktopFocus(device, input, extra.signal)));

  server.registerTool("desktop_mouse", {
    description: "Read/move mouse pointer, click/double-click buttons, or scroll using global desktop coordinates.",
    inputSchema: desktopMouseSchema.safeExtend({ device: z.string().min(1) }),
  }, async ({ device, ...input }, extra) => text(await client.desktopMouse(device, input, extra.signal)));

  server.registerTool("desktop_keyboard", {
    description: "Type arbitrary text, press keys, or send a hotkey to the focused interactive window.",
    inputSchema: desktopKeyboardSchema.safeExtend({ device: z.string().min(1) }),
  }, async ({ device, ...input }, extra) => text(await client.desktopKeyboard(device, input, extra.signal)));

  server.registerTool("desktop_clipboard_get", {
    description: "Read text from the interactive desktop clipboard.", inputSchema: { device: z.string().min(1) },
  }, async ({ device }, extra) => text(await client.desktopClipboard(device, extra.signal)));

  server.registerTool("desktop_clipboard_set", {
    description: "Replace interactive desktop clipboard text.", inputSchema: { device: z.string().min(1), text: z.string() },
  }, async ({ device, text: value }, extra) => text(await client.desktopClipboardSet(device, { text: value }, extra.signal)));

  server.registerTool("desktop_launch", {
    description: "Launch an application/document in the interactive desktop session and verify process session + optional HWND/window. Reports UAC Secure Desktop visibility boundaries; does not disable Secure Desktop.",
    inputSchema: {
      device: z.string().min(1), target: z.string().min(1), arguments: z.array(z.string()).optional(),
      waitForWindowMs: z.number().int().min(0).max(10_000).optional(), requireWindow: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ device, ...input }, extra) => text(await client.desktopLaunch(device, input, extra.signal)));

  server.registerTool("browser_open", {
    description: "Open a URL in a detected interactive browser (Edge, Chrome, Brave or Firefox), optionally forcing a new window.",
    inputSchema: { device: z.string().min(1), url: z.string().url(), browser: z.enum(["auto", "edge", "chrome", "brave", "firefox"]).optional(), newWindow: z.boolean().optional() },
  }, async ({ device, ...input }, extra) => text(await client.desktopBrowserOpen(device, input, extra.signal)));
}
