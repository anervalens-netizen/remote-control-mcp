import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const FILES_EXTENSION = "io.modelcontextprotocol/files";
export const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const WIRE_RESULT = "io.remote-control-mcp/internal-extension-result";
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_INLINE_BYTES = 1024 * 1024;
export const UPLOAD_TTL_MS = 60 * 60 * 1000;
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class ExtensionError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message); this.name = "ExtensionError"; this.code = code; this.data = data;
  }
}
export function extensionSettings(meta: Record<string, unknown> | undefined, extension: string): Record<string, unknown> | undefined {
  const caps = meta?.[CLIENT_CAPABILITIES] as { extensions?: Record<string, unknown> } | undefined;
  const setting = caps?.extensions?.[extension];
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return undefined;
  if ((setting as Record<string, unknown>).revision !== undefined) return undefined;
  return setting as Record<string, unknown>;
}
export function requireExtension(meta: Record<string, unknown> | undefined, extension: string): void {
  if (!extensionSettings(meta, extension)) throw new ExtensionError(-32021, "Required client extension is not declared", { requiredExtensions: [extension] });
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}
export function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("base64url"); }
export function validOpaqueId(id: string): boolean { return /^[A-Za-z0-9_-]{43}$/.test(id); }
export const opaqueId = () => randomBytes(32).toString("base64url");

/** Private, restart-stable state. No command text or access token is stored in handles. */
export class ExtensionStore {
  readonly root: string;
  private keyPromise?: Promise<Buffer>;
  constructor(root = process.env.RCMCP_MCP_EXTENSIONS_DIR ?? path.join(homedir(), ".remote-control-mcp", "mcp-extensions")) {
    this.root = path.resolve(root);
  }
  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await stat(this.root);
    if (!root.isDirectory() || (root.mode & 0o077) !== 0) throw new Error("MCP extension state directory must be private (0700)");
    for (const dir of ["uploads", "artifacts"]) await mkdir(path.join(this.root, dir), { recursive: true, mode: 0o700 });
  }
  location(kind: "uploads" | "artifacts", id: string, suffix: string): string {
    if (!validOpaqueId(id) || !/^\.[a-z]+$/.test(suffix)) throw new ExtensionError(-32602, "Invalid transfer identity");
    return path.join(this.root, kind, id + suffix);
  }
  async read<T>(kind: "uploads" | "artifacts", id: string): Promise<T> {
    const filename = this.location(kind, id, ".json");
    let handle;
    try {
      handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Invalid metadata");
      return JSON.parse(await handle.readFile("utf8")) as T;
    } catch { throw new ExtensionError(-32602, "Transfer state is missing or unavailable"); }
    finally { await handle?.close(); }
  }
  async write(kind: "uploads" | "artifacts", id: string, value: unknown): Promise<void> {
    await this.ready();
    const file = this.location(kind, id, ".json");
    const h = await open(file, "wx", 0o600);
    try { await h.writeFile(JSON.stringify(value)); await h.sync(); } finally { await h.close(); }
    await this.syncDirectory(path.dirname(file));
  }
  async consume(id: string): Promise<void> {
    let h;
    try { h = await open(this.location("uploads", id, ".consumed"), "wx", 0o600); }
    catch { throw new ExtensionError(-32602, "Upload state was already consumed; the outcome may be unknown. Inspect the original artifact or job; do not retry automatically."); }
    try { await h.writeFile(new Date().toISOString()); await h.sync(); } finally { await h.close(); }
    await this.syncDirectory(path.join(this.root, "uploads"));
  }
  async isConsumed(id: string): Promise<boolean> {
    try { await stat(this.location("uploads", id, ".consumed")); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  async syncDirectory(dir: string): Promise<void> {
    const h = await open(dir, constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); }
  }
  async key(): Promise<Buffer> {
    return this.keyPromise ??= (async () => {
      await this.ready();
      const target = path.join(this.root, "handle-key");
      try {
        const h = await open(target, "wx", 0o600);
        try { await h.writeFile(randomBytes(32)); await h.sync(); } finally { await h.close(); }
        await this.syncDirectory(this.root);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const h = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await h.stat();
        if (!info.isFile() || info.size !== 32 || (info.mode & 0o077)) throw new Error("Invalid private handle key");
        return await h.readFile();
      } finally { await h.close(); }
    })();
  }
  async sign(value: Record<string, unknown>): Promise<string> {
    const payload = Buffer.from(canonicalJson(value)).toString("base64url");
    return "rct1." + payload + "." + createHmac("sha256", await this.key()).update(payload).digest("base64url");
  }
  async verify<T>(token: string): Promise<T> {
    if (typeof token !== "string" || token.length > 4096) throw new ExtensionError(-32602, "Unknown task");
    const [prefix, payload, signature, extra] = token.split(".");
    if (prefix !== "rct1" || !payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new ExtensionError(-32602, "Unknown task");
    const expected = createHmac("sha256", await this.key()).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ExtensionError(-32602, "Unknown task");
    try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T; }
    catch { throw new ExtensionError(-32602, "Unknown task"); }
  }
  async writeBytes(kind: "uploads" | "artifacts", id: string, input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, expectedSize?: number, expectedDigest?: string): Promise<{ size: number; digest: string; path: string }> {
    await this.ready();
    const temp = this.location(kind, id, ".part");
    const final = this.location(kind, id, ".bin");
    const h = await open(temp, "wx", 0o600);
    const hash = createHash("sha256"); let size = 0;
    try {
      try {
        for await (const chunk of input) {
          size += chunk.byteLength;
          if (size > MAX_FILE_BYTES || (expectedSize !== undefined && size > expectedSize)) throw new Error("File exceeds declared size or transfer limit");
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) { const { bytesWritten } = await h.write(chunk, offset); if (!bytesWritten) throw new Error("Short file write"); offset += bytesWritten; }
        }
        const digest = hash.digest("base64url");
        if (expectedSize !== undefined && size !== expectedSize) throw new Error("Uploaded file size does not match metadata");
        if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error("Uploaded file SHA-256 does not match metadata");
        await h.sync(); await h.close();
        // The .part reservation prevents concurrent writes; the immutable final
        // name is never replaced after a successful upload.
        try { await stat(final); throw new Error("File was already uploaded"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(temp, final); await this.syncDirectory(path.dirname(final));
        return { size, digest, path: final };
      } catch (error) { await h.close().catch(() => {}); throw error; }
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }
  stream(kind: "uploads" | "artifacts", id: string): AsyncIterable<Uint8Array> {
    const filename = this.location(kind, id, ".bin");
    return (async function* () {
      const h = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { for await (const chunk of h.createReadStream()) yield chunk as Buffer; }
      finally { await h.close().catch(() => {}); }
    })();
  }
}
