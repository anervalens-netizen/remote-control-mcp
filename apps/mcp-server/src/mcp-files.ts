import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ARTIFACT_TTL_MS, ExtensionError, ExtensionStore, FILES_EXTENSION, MAX_FILE_BYTES, MAX_INLINE_BYTES, UPLOAD_TTL_MS, WIRE_RESULT, canonicalJson, extensionSettings, opaqueId, validOpaqueId } from "./mcp-extension-store.ts";
import type { ResultRecoveryStore } from "./result-recovery.ts";

const digestSchema = z.object({ algorithm: z.literal("sha-256"), value: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const fileInputSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().max(512).optional(), mimeType: z.string().min(1).max(200),
  size: z.number().int().min(0).max(MAX_FILE_BYTES), digest: digestSchema.optional(),
  data: z.string().max(Math.ceil(MAX_INLINE_BYTES / 3) * 4).optional(),
}).strict().meta({ "x-mcp-file": { maxSize: MAX_FILE_BYTES } });
export const uploadSchema = z.object({ file: fileInputSchema }).strict();
const receiveSchema = z.object({ file: z.object({
  download_url: z.string().url().max(8192), file_id: z.string().min(1).max(512),
  file_name: z.string().max(512).optional(), mime_type: z.string().max(200).optional(),
}).strict(), sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }).strict();
const artifactSchema = z.object({ artifactId: z.string().regex(/^[A-Za-z0-9_-]{43}$/), name: z.string(), mimeType: z.string(), size: z.number().int().nonnegative(), digest: digestSchema,
  createdAt: z.string(), expiresAt: z.string(), controllerPath: z.string() }).passthrough();
const uploadOutputSchema = z.union([artifactSchema, z.object({ uploadPending: z.literal(true), requestState: z.string(), uploads: z.array(z.record(z.string(), z.unknown())) }).passthrough()]);
export type FileInput = z.infer<typeof fileInputSchema>;
type UploadArguments = z.infer<typeof uploadSchema> & { resultRecoveryId?: string };
type UploadBinding = { arguments: UploadArguments; recoveryId?: string };
type UploadState = UploadBinding & { tool: "file_upload"; principal: string; expiresAt: string; createdAt: string };
type UploadContext = UploadBinding & { meta?: Record<string, unknown>; requestState?: string; staging: boolean; conflictingRecovery: boolean };
type Artifact = { artifactId: string; name: string; mimeType: string; size: number; digest: { algorithm: "sha-256"; value: string }; principal: string; createdAt: string; expiresAt: string; controllerPath: string };
const result = (value: Record<string, unknown>, extra: Partial<CallToolResult> = {}): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...extra });
const safeName = (value?: string) => { const name = (value ?? "file").split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "_"); return (!name || name === "." || name === ".." ? "file" : name).slice(0, 240); };
const expiry = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
export type FileSourceFetcher = (url: string) => Promise<AsyncIterable<Uint8Array>>;

/** Pin a public DNS answer into the TLS connection. No redirect, proxy,
 * cookies, MCP credentials, compression or private-network request is sent. */
export async function publicFileSource(raw: string): Promise<AsyncIterable<Uint8Array>> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443" || net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw new Error("File URL must use public HTTPS without credentials");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("File URL resolves to a non-public address");
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { accept: "application/octet-stream", "accept-encoding": "identity" },
      signal: AbortSignal.timeout(120_000),
      family: selected.family,
      lookup: (_host, _options, callback) => { callback(null, selected.address, selected.family); },
    }, response => {
      if (response.statusCode !== 200 || response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new Error("File download requires an uncompressed HTTP 200 response; redirects are refused")); return;
      }
      const length = response.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_FILE_BYTES)) {
        response.destroy(); reject(new Error("File exceeds transfer limit")); return;
      }
      resolve(response);
    });
    request.setTimeout(60_000, () => request.destroy(new Error("File download timed out")));
    request.once("error", () => reject(new Error("File download failed; no automatic retry was performed")));
  });
}
export function isPublicAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31
      || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 100 && b! >= 64 && b! <= 127 || a! >= 224 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  // Public global unicast only. IPv4-mapped and local/special ranges do not pass.
  if (net.isIP(address) !== 6 || !/^[23][0-9a-f]{0,3}:/i.test(address)) return false;
  const groups = address.split(":");
  const first = parseInt(groups[0]!, 16), second = parseInt(groups[1] || "0", 16);
  return first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

export class McpFiles {
  private transfers = 0;
  private admissionTail = Promise.resolve();
  private receiveReservations = 0;
  private readonly contexts = new WeakMap<object, UploadContext>();
  readonly store: ExtensionStore;
  readonly principal: string;
  private readonly fetchSource: FileSourceFetcher;
  private readonly recovery?: ResultRecoveryStore;
  constructor(store: ExtensionStore, principal: string, fetchSource: FileSourceFetcher = publicFileSource, recovery?: ResultRecoveryStore) { this.store = store; this.principal = principal; this.fetchSource = fetchSource; this.recovery = recovery; }
  private async admit<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.admissionTail; let release!: () => void;
    this.admissionTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
  private async budget(requestedSize = MAX_FILE_BYTES): Promise<void> {
    await this.store.ready();
    const uploadRows = await readdir(path.join(this.store.root, "uploads"));
    const artifactRows = await readdir(path.join(this.store.root, "artifacts"));
    if (uploadRows.filter(x => x.endsWith(".json")).length >= 64 || artifactRows.filter(x => x.endsWith(".json")).length >= 512) throw new Error("Transfer store capacity reached; expire or remove previous transfers before adding files");
    let reserved = this.receiveReservations, pendingArtifacts = this.receiveReservations / MAX_FILE_BYTES;
    for (const [kind, rows] of [["uploads", uploadRows], ["artifacts", artifactRows]] as const) for (const file of rows.filter(x => x.endsWith(".json"))) {
      const item = await this.store.read<{ size?: number; arguments?: { file?: { size?: number } } }>(kind, file.slice(0, -5));
      const size = item.size ?? item.arguments?.file?.size ?? MAX_FILE_BYTES;
      // A pending upload reserves its staged bytes and one finalized copy.
      // Consuming and publishing metadata share the admission lock, so another
      // call cannot observe a consumed row before its artifact is charged.
      const pending = kind === "uploads" && !await this.store.isConsumed(file.slice(0, -5));
      if (pending) pendingArtifacts++;
      reserved += size * (pending ? 2 : 1);
    }
    if (artifactRows.filter(x => x.endsWith(".json")).length + pendingArtifacts >= 512) throw new Error("Transfer store artifact reservations are full");
    // Count crash-orphaned binary files conservatively as well. Normal pending
    // upload bytes have metadata; receive reservations cover live pull writes.
    for (const [kind, rows] of [["uploads", uploadRows], ["artifacts", artifactRows]] as const) for (const file of rows.filter(x => /\.(bin|part)$/.test(x))) {
      if (rows.includes(file.replace(/\.(bin|part)$/, ".json"))) continue;
      try { reserved += (await stat(path.join(this.store.root, kind, file))).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Racing finalization copies are transient and bounded by the four-transfer
    // admission limit; each losing copy is removed without publishing metadata.
    if (reserved + requestedSize > 1024 * 1024 * 1024) throw new Error("Transfer store byte budget reached; retained artifacts expire after seven days");
  }
  /** Invoke the existing registered wrapper exactly once. A preparatory
   * upload_required has its own automatic receipt; the caller's single-use
   * reservation remains available for the exact-arguments final retry. */
  async invokeUpload<T extends { _meta?: Record<string, unknown> }>(handler: (args: unknown, extra: T) => Promise<CallToolResult>, args: UploadArguments, extra: T, requestState?: string): Promise<CallToolResult> {
    const explicit = args.resultRecoveryId, metadataId = extra._meta?.resultRecoveryId;
    const recoveryId = explicit ?? metadataId;
    const staging = requestState === undefined && args.file.data === undefined && args.file.size > 0;
    const { resultRecoveryId: _argumentId, ...stagingArguments } = args;
    const { resultRecoveryId: _metadataId, ...stagingMeta } = extra._meta ?? {};
    const callbackExtra = { ...extra, ...(staging ? { _meta: stagingMeta } : {}) };
    this.contexts.set(callbackExtra, { arguments: args, recoveryId: recoveryId as string | undefined, meta: extra._meta, requestState, staging,
      conflictingRecovery: explicit !== undefined && metadataId !== undefined && explicit !== metadataId });
    try { return await handler(staging ? stagingArguments : args, callbackExtra); }
    finally { this.contexts.delete(callbackExtra); }
  }
  async toolUpload(args: z.infer<typeof uploadSchema>, extra: object): Promise<CallToolResult> {
    const context = this.contexts.get(extra);
    try {
      if (context?.staging && context.recoveryId !== undefined) {
        if (context.conflictingRecovery || !z.string().uuid().safeParse(context.recoveryId).success || !this.recovery || this.recovery.read(context.recoveryId).state !== "reserved") throw new ExtensionError(-32602, "Invalid or used final result recovery reservation; no upload was prepared");
      }
      const native = await this.upload(args, context?.meta, context?.requestState, context);
      if (native.resultType === "complete") { const { resultType: _type, ...complete } = native; return complete as unknown as CallToolResult; }
      return { content: [{ type: "text", text: "File transfer is pending; recover this staging receipt if delivery is interrupted" }],
        structuredContent: { uploadPending: true, requestState: native.requestState, uploads: native.uploads }, _meta: { [WIRE_RESULT]: { result: native } } };
    } catch (error) {
      if (context && error instanceof ExtensionError) return { content: [{ type: "text", text: error.message }], structuredContent: { ok: false, error: error.message }, isError: true,
        _meta: { [WIRE_RESULT]: { error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } } } };
      throw error;
    }
  }
  async metadata(id: string): Promise<Artifact> {
    const value = await this.store.read<Artifact>("artifacts", id);
    if (value.principal !== this.principal || !expiry(value.expiresAt)) throw new ExtensionError(-32602, "Artifact expired or unavailable for this principal");
    const info = await stat(this.store.location("artifacts", id, ".bin"));
    if (!info.isFile() || info.size !== value.size) throw new Error("Artifact bytes are unavailable");
    return value;
  }
  private async record(id: string, name: string | undefined, mimeType: string, size: number, digest: string): Promise<Artifact> {
    const value: Artifact = { artifactId: id, name: safeName(name), mimeType, size, digest: { algorithm: "sha-256", value: digest }, principal: this.principal,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS).toISOString(), controllerPath: this.store.location("artifacts", id, ".bin") };
    await this.store.write("artifacts", id, value);
    return value;
  }
  private visible(artifact: Artifact): Record<string, unknown> {
    const { principal: _principal, ...visible } = artifact;
    return { ...visible, nextStep: { tool: "file_transfer", arguments: { sourcePath: artifact.controllerPath },
      requiredArguments: ["sourceDevice", "sourceContext", "destinationDevice", "destinationContext", "destinationPath"],
      sourceRequirement: "Select the configured agent and identity on the controller host that can read sourcePath. Use the original name for the destination filename when appropriate. File bytes stay outside model context." } };
  }
  async upload(args: z.infer<typeof uploadSchema>, meta?: Record<string, unknown>, requestState?: string, binding: UploadBinding = { arguments: args }): Promise<Record<string, unknown>> {
    if (this.transfers >= 4) throw new Error("Four file transfers are already active");
    this.transfers++;
    try { return await this.uploadAdmitted(args, meta, requestState, binding); }
    finally { this.transfers--; }
  }
  private async uploadAdmitted(args: z.infer<typeof uploadSchema>, meta: Record<string, unknown> | undefined, requestState: string | undefined, binding: UploadBinding): Promise<Record<string, unknown>> {
    const file = args.file;
    if (requestState !== undefined) {
      if (!validOpaqueId(requestState)) throw new ExtensionError(-32602, "Invalid upload state");
      const state = await this.store.read<UploadState>("uploads", requestState);
      if (!expiry(state.expiresAt) || state.principal !== this.principal || state.tool !== "file_upload" || canonicalJson(state.arguments) !== canonicalJson(binding.arguments) || state.recoveryId !== binding.recoveryId || await this.store.isConsumed(requestState)) throw new ExtensionError(-32602, "Invalid, changed, expired or consumed upload state; do not retry automatically");
      const content = this.store.stream("uploads", requestState);
      const artifactId = opaqueId();
      const sealed = await this.store.writeBytes("artifacts", artifactId, content, file.size, file.digest?.value);
      try {
        const artifact = await this.admit(async () => {
          await this.store.consume(requestState);
          return this.record(artifactId, file.name, file.mimeType, sealed.size, sealed.digest);
        });
        return { resultType: "complete", ...result(this.visible(artifact)) };
      } catch (error) { await unlink(sealed.path).catch(() => {}); throw error; }
    }
    return this.admit(async () => {
      await this.budget(file.data !== undefined || file.size === 0 ? file.size : 2 * file.size);
      if (file.data !== undefined || file.size === 0) {
        if (file.data !== undefined && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error("File data is not canonical base64");
        const bytes = Buffer.from(file.data ?? "", "base64");
        if (bytes.length > MAX_INLINE_BYTES) throw new Error("Inline file exceeds the 1 MiB limit");
        const id = opaqueId();
        const sealed = await this.store.writeBytes("artifacts", id, [bytes], file.size, file.digest?.value);
        try {
          const artifact = await this.record(id, file.name, file.mimeType, sealed.size, sealed.digest);
          return { resultType: "complete", ...result(this.visible(artifact)) };
        } catch (error) { await unlink(sealed.path).catch(() => {}); throw error; }
      }
      if (!extensionSettings(meta, FILES_EXTENSION)?.upload) throw new ExtensionError(-32021, "Out-of-band upload needs the Files extension; use file_receive for a ChatGPT attachment or inline data", { requiredExtensions: [FILES_EXTENSION] });
      const id = opaqueId(), expiresAt = new Date(Date.now() + UPLOAD_TTL_MS).toISOString();
      await this.store.write("uploads", id, { tool: "file_upload", arguments: binding.arguments, recoveryId: binding.recoveryId, principal: this.principal, expiresAt, createdAt: new Date().toISOString() } satisfies UploadState);
      return { resultType: "upload_required", requestState: id, uploads: [{ fileId: file.id, path: "/files/uploads/" + id, method: "PUT", credentials: "include", expiresAt }] };
    });
  }
  async receive(args: z.infer<typeof receiveSchema>): Promise<CallToolResult> {
    if (this.transfers >= 4) throw new Error("Four file transfers are already active");
    this.transfers++;
    let reserved = false, sealedPath: string | undefined;
    try {
      await this.admit(async () => { await this.budget(); this.receiveReservations += MAX_FILE_BYTES; reserved = true; });
      const id = opaqueId();
      const source = await this.fetchSource(args.file.download_url);
      const digest = args.sha256 ? Buffer.from(args.sha256, "hex").toString("base64url") : undefined;
      const sealed = await this.store.writeBytes("artifacts", id, source, undefined, digest);
      sealedPath = sealed.path;
      const artifact = await this.admit(async () => {
        const artifact = await this.record(id, args.file.file_name, args.file.mime_type ?? "application/octet-stream", sealed.size, sealed.digest);
        this.receiveReservations -= MAX_FILE_BYTES; reserved = false; return artifact;
      });
      sealedPath = undefined;
      return result(this.visible(artifact));
    } finally {
      if (sealedPath) await unlink(sealedPath).catch(() => {});
      if (reserved) await this.admit(async () => { this.receiveReservations -= MAX_FILE_BYTES; });
      this.transfers--;
    }
  }
  async download(id: string, meta?: Record<string, unknown>): Promise<CallToolResult> {
    const artifact = await this.metadata(id);
    const downloads = extensionSettings(meta, FILES_EXTENSION)?.download ? [{ name: artifact.name, mimeType: artifact.mimeType, size: artifact.size, digest: artifact.digest,
      path: "/files/downloads/" + id, credentials: "include", expiresAt: artifact.expiresAt }] : undefined;
    return result(this.visible(artifact), downloads ? { _meta: { [FILES_EXTENSION]: { downloads } } } : {});
  }
  async route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const match = /^\/mcp\/files\/(uploads|downloads)\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? "");
    if (!match) return false;
    const kind = match[1]!, id = match[2]!;
    try {
      if (kind === "uploads") {
        if (req.method !== "PUT") { res.writeHead(405).end(); return true; }
        const state = await this.store.read<UploadState>("uploads", id);
        if (state.principal !== this.principal || !expiry(state.expiresAt) || await this.store.isConsumed(id)) throw new ExtensionError(-32602, "Upload expired or unavailable");
        if (this.transfers >= 4) { res.writeHead(429).end("Transfer capacity reached"); return true; }
        const length = req.headers["content-length"];
        if (length === undefined || !/^\d+$/.test(length) || Number(length) !== state.arguments.file.size || req.headers["content-encoding"]) throw new Error("Content-Length must match the declared file size; encoded bodies are not accepted");
        this.transfers++;
        const timer = setTimeout(() => req.destroy(new Error("Upload deadline exceeded")), 120_000); timer.unref();
        try { await this.store.writeBytes("uploads", id, req, state.arguments.file.size, state.arguments.file.digest?.value); }
        finally { clearTimeout(timer); this.transfers--; }
        res.writeHead(204, { "cache-control": "no-store" }).end();
      } else {
        if (req.method !== "GET") { res.writeHead(405).end(); return true; }
        const artifact = await this.metadata(id);
        if (this.transfers >= 4) { res.writeHead(429).end("Transfer capacity reached"); return true; }
        this.transfers++;
        const timer = setTimeout(() => res.destroy(new Error("Download deadline exceeded")), 120_000); timer.unref();
        try {
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": artifact.size, "cache-control": "no-store", "x-content-type-options": "nosniff" });
          await pipeline(this.store.stream("artifacts", id), res);
        } finally { clearTimeout(timer); this.transfers--; }
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(error instanceof ExtensionError ? 404 : 400, { "content-type": "application/json", "cache-control": "no-store" });
      if (!res.writableEnded) res.end(JSON.stringify({ error: "file_transfer_failed", message: error instanceof Error ? error.message : "File transfer failed" }));
    }
    return true;
  }
  async cleanup(): Promise<void> {
    await this.admit(async () => {
      for (const kind of ["uploads", "artifacts"] as const) {
        const dir = path.join(this.store.root, kind);
        let names: string[]; try { names = await readdir(dir); } catch { continue; }
        for (const name of names.filter(x => x.endsWith(".json")).slice(0, 1024)) {
          const id = name.slice(0, -5); if (!validOpaqueId(id)) continue;
          try {
            const record = await this.store.read<{ expiresAt: string }>(kind, id);
            if (Date.parse(record.expiresAt) + 120_000 >= Date.now()) continue;
            for (const suffix of [".bin", ".part", ".consumed", ".json"]) await unlink(this.store.location(kind, id, suffix)).catch(() => {});
          } catch { /* Corrupt metadata is retained for inspection, never replayed. */ }
        }
      }
    });
  }
}

/** The same tools remain usable by legacy hosts: OpenAI attachment pull and
 * bounded inline FileInput. Modern out-of-band results are encoded separately. */
export function registerFileTools(server: McpServer, files: McpFiles): void {
  server.registerTool("file_receive", { description: "Receive one ChatGPT/Codex attachment into the private controller workspace. Downloads a public HTTPS file without forwarding credentials; verifies size and SHA-256, retains an immutable artifact for seven days. No import, execution or overwrite occurs.", inputSchema: receiveSchema, outputSchema: artifactSchema,
    _meta: { "openai/fileParams": ["file"] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } }, async args => files.receive(args));
  server.registerTool("file_upload", { description: "Stage one file as an immutable controller artifact for seven days. Inline base64 is limited to 1 MiB; modern Files clients may upload up to 150 MiB out of band then retry with requestState. Returns controllerPath for explicit subsequent file_transfer or processing. Does not import or execute.", inputSchema: uploadSchema, outputSchema: uploadOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args, extra) => files.toolUpload(args, extra));
  server.registerTool("file_download", { description: "Read an existing artifact receipt and, for Files-capable clients, an authenticated download target. No execution or new source download occurs.", inputSchema: z.object({ artifactId: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(), outputSchema: artifactSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args, extra) => files.download(args.artifactId, extra._meta));
}
