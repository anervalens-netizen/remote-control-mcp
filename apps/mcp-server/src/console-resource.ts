import { readFile } from "node:fs/promises";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiResourceMetadata } from "@openai/mcp-extensions/server";

function telemetryDomains(): string[] {
  try { return process.env.GLITCHTIP_DSN ? [new URL(process.env.GLITCHTIP_DSN).origin] : []; }
  catch { return []; }
}

export const CONSOLE_URI = "ui://remote-control/console/v1.html";
export const consoleIcon = { src: "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="3" fill="#247d74"/><path d="M8 21h8M12 17v4M6 8l3 2-3 2m6 0h5" fill="none" stroke="#fff" stroke-width="2"/></svg>').toString("base64"), mimeType: "image/svg+xml", sizes: ["any"] };

/** Shared resource definitions are registered per SDK/session, unlike tool
 * callbacks whose recovery/observation stores intentionally survive reconnect. */
export const consoleResource = {
  name: "remote-control-console", uri: CONSOLE_URI,
  metadata: { mimeType: RESOURCE_MIME_TYPE, description: "Read-only fleet and operation console", icons: [consoleIcon] },
  read: async () => ({ contents: [{ uri: CONSOLE_URI, mimeType: RESOURCE_MIME_TYPE,
    text: await readFile(new URL("../../console/dist/console.html", import.meta.url), "utf8"),
    _meta: { ui: { csp: { connectDomains: telemetryDomains(), resourceDomains: [] }, prefersBorder: true },
      "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["fullscreen"] } satisfies OpenAIUiResourceMetadata } }] }),
};
