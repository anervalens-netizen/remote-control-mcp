import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  androidCommandRequestSchema,
  androidGlobalActionRequestSchema,
  androidNodeActionRequestSchema,
  androidOpenAppRequestSchema,
  androidSetTextRequestSchema,
  androidShellRequestSchema,
  androidSwipeRequestSchema,
  androidTapRequestSchema,
} from "../../../packages/protocol/src/android.ts";
import type { AgentClient } from "./agent-client.ts";

const commandResultSchema = z.object({
  commandId: z.string().uuid(), status: z.enum(["completed", "error", "outcome_unknown", "cancelled", "expired"]), ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional(),
}).passthrough();

const actionRequestSchema = z.discriminatedUnion("operation", [
  androidTapRequestSchema, androidSwipeRequestSchema, androidSetTextRequestSchema,
  androidNodeActionRequestSchema, androidGlobalActionRequestSchema, androidOpenAppRequestSchema,
]);

const statusSchema = z.object({
  name: z.string(), transport: z.literal("android-reverse"), online: z.boolean(),
  readiness: z.string(), readinessReason: z.string(), observedAt: z.number().nullable(), lastPollAt: z.number().nullable(),
  state: z.record(z.string(), z.unknown()).nullable(), queuedCommands: z.number().int().nonnegative(), activeCommandId: z.string().nullable(),
}).passthrough();

type DecodedImage = { bytes: Buffer; width: number; height: number };

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof && length >= 7) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return { width, height };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    const height = 1 + ((bytes[22]! & 0xc0) >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    return { width, height };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

function decodedImage(data: unknown, mimeType: unknown): DecodedImage | null {
  if (typeof data !== "string" || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return null;
  let dimensions: { width: number; height: number } | null = null;
  if (mimeType === "image/png" && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    && bytes.toString("ascii", 12, 16) === "IHDR") dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  else if (mimeType === "image/jpeg" && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) dimensions = jpegDimensions(bytes);
  else if (mimeType === "image/webp" && bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") dimensions = webpDimensions(bytes);
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  return { bytes, ...dimensions };
}

function sanitizeImage(value: unknown, expected?: { width: number; height: number }): { value: unknown; image?: { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" } } {
  if (!value || typeof value !== "object") return { value };
  if (Array.isArray(value)) {
    const values = value.map((item) => sanitizeImage(item));
    return { value: values.map((item) => item.value), image: values.find((item) => item.image)?.image };
  }
  const source = value as Record<string, unknown>;
  const snapshot = source.snapshot && typeof source.snapshot === "object" && !Array.isArray(source.snapshot)
    ? source.snapshot as Record<string, unknown> : null;
  const localExpected = snapshot && typeof snapshot.width === "number" && typeof snapshot.height === "number"
    ? { width: snapshot.width, height: snapshot.height } : expected;
  const output: Record<string, unknown> = {};
  let image: { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" } | undefined;
  for (const [key, item] of Object.entries(source)) {
    if (key === "image" && item && typeof item === "object" && !Array.isArray(item)) {
      const candidate = item as Record<string, unknown>;
      const data = candidate.data;
      const mimeType = candidate.mimeType;
      const decoded = candidate.available === true ? decodedImage(data, mimeType) : null;
      if (decoded && typeof data === "string" && (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp")
          && (!localExpected || (decoded.width === localExpected.width && decoded.height === localExpected.height))) {
        image = { data, mimeType };
        output.image = { available: true, mimeType, bytes: decoded.bytes.length, width: decoded.width, height: decoded.height };
      } else if (decoded && localExpected) {
        output.image = { available: false, reason: "image_dimensions_mismatch", actualWidth: decoded.width, actualHeight: decoded.height,
          expectedWidth: localExpected.width, expectedHeight: localExpected.height };
      } else if (candidate.available === false && typeof candidate.reason === "string") {
        output.image = { available: false, reason: candidate.reason };
      } else {
        output.image = { available: false, reason: "invalid_image_data" };
      }
      continue;
    }
    const nested = sanitizeImage(item, localExpected);
    output[key] = nested.value;
    image ??= nested.image;
  }
  return { value: output, ...(image ? { image } : {}) };
}

function resultResponse(value: unknown): any {
  const sanitized = sanitizeImage(value);
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [{ type: "text", text: JSON.stringify(sanitized.value) }];
  if (sanitized.image) content.push({ type: "image", data: sanitized.image.data, mimeType: sanitized.image.mimeType });
  return { content, structuredContent: sanitized.value };
}

export function registerAndroidTools(server: McpServer, client: AgentClient): void {
  if (!client.androidController) return;

  server.registerTool("android_status", {
    description: "Return truthful authenticated Android reverse-controller readiness and observed state. Readiness is not proof of an effect.",
    inputSchema: { device: z.string().min(1) }, outputSchema: statusSchema, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device }) => resultResponse(client.androidStatus(device)));

  server.registerTool("android_observe", {
    description: "Observe Android UI state. A read-only command UUID is generated by the controller; unavailable screenshots are explicit partial results.",
    inputSchema: { device: z.string().min(1), image: z.boolean().optional(), tree: z.boolean().optional(), maxNodes: z.number().int().min(1).max(1000).optional() },
    outputSchema: commandResultSchema, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device, image, tree, maxNodes }, extra) => {
    const commandId = randomUUID();
    const result = await client.androidObserve(device, commandId, { operation: "observe", image: image ?? true, tree: tree ?? true, maxNodes: maxNodes ?? 200 }, Date.now() + 30_000, extra.signal);
    return resultResponse(result);
  });

  server.registerTool("android_action", {
    description: "Perform one serialized Android UI action. commandId must remain stable across caller retries; never use a new UUID to retry an uncertain effect.",
    inputSchema: { device: z.string().min(1), commandId: z.string().uuid(), request: actionRequestSchema },
    outputSchema: commandResultSchema,
  }, async ({ device, commandId, request }, extra) => resultResponse(await client.androidAction(device, commandId, request, Date.now() + 60_000, extra.signal)));

  server.registerTool("android_shell", {
    description: "Execute an unrestricted shell command through the optional Shizuku UserService. The phone reports shell availability truthfully; commandId must remain stable across caller retries.",
    inputSchema: {
      device: z.string().min(1), commandId: z.string().uuid(),
      command: z.string().min(1),
      timeoutMs: z.number().int().min(1).max(600_000).optional(),
      maxOutputBytes: z.number().int().min(1).max(8 * 1024 * 1024).optional(),
    },
    outputSchema: commandResultSchema,
  }, async ({ device, commandId, command, timeoutMs, maxOutputBytes }, extra) => {
    const request = androidShellRequestSchema.parse({
      operation: "shell", command, timeoutMs: timeoutMs ?? 120_000, maxOutputBytes: maxOutputBytes ?? 1024 * 1024,
    });
    const deadline = Date.now() + request.timeoutMs + 15_000;
    return resultResponse(await client.androidAction(device, commandId, request, deadline, extra.signal));
  });

  server.registerTool("android_command_status", {
    description: "Look up an Android command without replaying it. Controller uncertainty may later resolve from the same delivery; compacted history is reported distinctly as history_unavailable while no-replay remains enforced.",
    inputSchema: { device: z.string().min(1), commandId: z.string().uuid() },
    outputSchema: z.object({ found: z.boolean(), commandId: z.string().uuid(), command: z.record(z.string(), z.unknown()).nullable() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ device, commandId }) => {
    const command = client.androidCommandStatus(device, commandId);
    return resultResponse({ found: command !== null, commandId, command });
  });
}
