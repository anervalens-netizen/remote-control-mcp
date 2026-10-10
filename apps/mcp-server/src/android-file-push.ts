import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, chmodSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { fsReadResultSchema } from "../../../packages/protocol/src/execution.ts";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";
import type { AndroidController } from "./android-controller.ts";

export const MAX_ANDROID_FILE_BYTES = 512 * 1024 * 1024;
const LIFETIME_MS = 10 * 60_000;
export const androidFilePushFields = {
  device: z.string().min(1), commandId: z.string().uuid(), sourceDevice: z.string().min(1),
  sourcePath: z.string().min(1), sourceContext: z.enum(["system", "user", "desktop"]).optional().default("system"),
  filename: z.string().min(1).max(1000).optional(),
};
const inputSchema = z.object(androidFilePushFields).strict();
export type AndroidFilePushInput = z.input<typeof inputSchema>;
const reservationSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), transferId: z.string().uuid(), expiresAt: z.number().int().positive() }).strict();
type Reservation = z.infer<typeof reservationSchema>;
type Staged = { device: string; commandId: string; bytes: number; expiresAt: number; timer: ReturnType<typeof setTimeout> };

export function sanitizeDownloadFilename(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? "";
  const safe = leaf.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "").slice(0, 120);
  return safe || "download.bin";
}

// Reservations are permanent no-replay identities; only staged byte files expire.
// One private stateDir belongs to one controller process, as with its command journal.
export class AndroidFilePushStore {
  private readonly dir: string;
  private readonly staged = new Map<string, Staged>();
  private readonly active = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly controller: AndroidController;
  constructor(stateDir: string, controller: AndroidController) {
    this.controller = controller;
    this.dir = path.join(stateDir, "android-file-push-v1");
    mkdirSync(this.dir, { mode: 0o700, recursive: true });
    chmodSync(this.dir, 0o700);
    // Restart never re-delivers a command, and no old staging bytes are needed.
    for (const file of readdirSync(this.dir)) if (/^[a-f0-9-]{36}\.bin$/.test(file) || file.endsWith(".tmp")) unlinkSync(path.join(this.dir, file));
  }
  private save(file: string, record: Reservation): void {
    const temp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    if (process.platform !== "win32") {
      const dir = openSync(this.dir, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    }
  }
  private cleanup(id: string): void {
    const item = this.staged.get(id);
    if (item) clearTimeout(item.timer);
    try { unlinkSync(path.join(this.dir, `${id}.bin`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.staged.delete(id);
  }
  close(): void {
    this.closed = true;
    let failure: unknown;
    for (const id of this.staged.keys()) { try { this.cleanup(id); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  }
  reservationStatus(device: string, commandId: string) {
    const key = createHash("sha256").update(`${device}\0${commandId}`).digest("hex");
    try { reservationSchema.parse(JSON.parse(readFileSync(path.join(this.dir, `${key}.json`), "utf8"))); }
    catch (error) {
      // A removed/replaced state directory has no readable reservation; actual
      // enqueue still requires a durable journal write and will fail closed.
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw error;
    }
    if (this.active.has(key)) return { commandId, status: "staging" as const, noReplay: true as const };
    return { commandId, status: "outcome_unknown" as const, ok: false, noReplay: true as const,
      error: { code: "file_push_reserved", message: "Transfer was previously reserved; inspect status without replay" } };
  }
  acceptsReservedCommand(device: string, commandId: string, request: { operation: string; transferId?: string }): boolean {
    const key = createHash("sha256").update(`${device}\0${commandId}`).digest("hex");
    let record: Reservation;
    try { record = reservationSchema.parse(JSON.parse(readFileSync(path.join(this.dir, `${key}.json`), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    return request.operation === "receive_file" && request.transferId === record.transferId;
  }
  push(client: Pick<AgentClient, "getDevice" | "info" | "fsRead">, raw: AndroidFilePushInput, signal?: AbortSignal): Promise<unknown> {
    const input = inputSchema.parse(raw);
    input.commandId = input.commandId.toLowerCase();
    input.device = this.controller.descriptor(input.device).name;
    input.sourceDevice = client.getDevice(input.sourceDevice).name;
    const filename = sanitizeDownloadFilename(input.filename ?? input.sourcePath);
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...input, filename })).digest("hex");
    const key = createHash("sha256").update(`${input.device}\0${input.commandId}`).digest("hex");
    const recordPath = path.join(this.dir, `${key}.json`);
    let previous: Reservation | undefined;
    try { previous = reservationSchema.parse(JSON.parse(readFileSync(recordPath, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("command_conflict: commandId is already bound to different file input");
      return this.active.get(key) ?? Promise.resolve(this.controller.lookup(input.device, input.commandId) ?? {
        commandId: input.commandId, status: "outcome_unknown", ok: false, noReplay: true,
        error: { code: "file_push_reserved", message: "Transfer was previously reserved; inspect status without replay" },
      });
    }
    if (this.closed) throw new Error("Android file push is closed");
    if (!(this.controller.status(input.device) as { online: boolean }).online) throw new Error("offline: Android device has no recent authenticated poll");
    const state = (this.controller.status(input.device) as { state?: { receiveFile?: boolean } }).state;
    if (state?.receiveFile !== true) throw new Error("unsupported_capability: Android companion does not advertise receiveFile");
    if (this.controller.lookup(input.device, input.commandId)) throw new Error("command_conflict: commandId was already used");
    if (this.active.size >= 4) throw new Error("Android file push staging capacity reached");
    signal?.throwIfAborted();
    const record: Reservation = { fingerprint, transferId: randomUUID(), expiresAt: Date.now() + LIFETIME_MS };
    this.save(recordPath, record); // Before any asynchronous read or dispatch.
    const pending = this.stage(client, input, filename, record, signal).finally(() => { this.active.delete(key); });
    this.active.set(key, pending);
    return pending;
  }
  private async stage(client: Pick<AgentClient, "info" | "fsRead">, input: z.output<typeof inputSchema>, filename: string, record: Reservation, callerSignal?: AbortSignal): Promise<unknown> {
    const file = path.join(this.dir, `${record.transferId}.bin`);
    let fd: number | undefined;
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(LIFETIME_MS)]) : AbortSignal.timeout(LIFETIME_MS);
    const context: AgentEndpointContext = input.sourceContext;
    const options = { signal };
    const read = async (offset: number, length: number, expectedVersion?: string) => {
      signal.throwIfAborted();
      if (this.closed || Date.now() >= record.expiresAt) throw new Error("Transfer staging expired");
      const result = fsReadResultSchema.parse(await client.fsRead(input.sourceDevice, {
        path: input.sourcePath, offset, length, encoding: "base64", versioned: true, ...(expectedVersion ? { expectedVersion } : {}),
      }, context, options));
      if (!result.sourceVersion || result.totalBytes === undefined || result.encoding !== "base64"
        || (expectedVersion && result.sourceVersion !== expectedVersion)) throw new Error("Source generation receipt mismatch");
      return result;
    };
    try {
      const info = await client.info(input.sourceDevice, context, options) as { runtime?: { relaySourceVersion?: number } };
      if ((info.runtime?.relaySourceVersion ?? 0) < 1) throw new Error("Source agent lacks generation-bound relay reads");
      const initial = await read(0, 0);
      const bytes = initial.totalBytes!;
      if (initial.bytesRead !== 0 || initial.data !== "" || initial.nextOffset !== 0) throw new Error("Invalid source metadata read");
      if (bytes > MAX_ANDROID_FILE_BYTES) throw new Error("File exceeds 512 MiB limit");
      fd = openSync(file, "wx", 0o600);
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < bytes) {
        const length = Math.min(1024 * 1024, bytes - offset);
        const result = await read(offset, length, initial.sourceVersion);
        if (result.data.length !== 4 * Math.ceil(length / 3)) throw new Error("Source returned incomplete or oversized encoded bytes");
        const chunk = Buffer.from(result.data, "base64");
        if (chunk.toString("base64") !== result.data || chunk.length !== length || result.bytesRead !== length
          || result.nextOffset !== offset + length || result.totalBytes !== bytes) throw new Error("Source returned incomplete or inconsistent bytes");
        writeFileSync(fd, chunk); hash.update(chunk); offset += chunk.length;
      }
      const final = await read(0, 0, initial.sourceVersion);
      if (final.totalBytes !== bytes || final.bytesRead !== 0 || final.data !== "" || final.nextOffset !== 0) throw new Error("Source length changed");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      const sha256 = hash.digest("hex");
      const timer = setTimeout(() => { try { this.cleanup(record.transferId); } catch { /* keep inaccessible expired bytes for operator cleanup */ } }, Math.max(1, record.expiresAt - Date.now()));
      timer.unref();
      this.staged.set(record.transferId, { device: input.device, commandId: input.commandId, bytes, expiresAt: record.expiresAt, timer });
      return await this.controller.execute(input.device, input.commandId, {
        operation: "receive_file", transferId: record.transferId, filename, sha256, bytes,
      }, record.expiresAt, signal);
    } finally {
      if (fd !== undefined) closeSync(fd);
      this.cleanup(record.transferId);
    }
  }
  async serve(device: string, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const item = this.staged.get(id);
    if (!item) { res.writeHead(404); res.end(); return; }
    if (device !== item.device) { res.writeHead(403); res.end(); return; }
    if (Date.now() >= item.expiresAt) { this.cleanup(id); res.writeHead(410); res.end(); return; }
    const command = this.controller.lookup(device, item.commandId);
    if (command?.status !== "dispatched") { res.writeHead(409); res.end(); return; }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": item.bytes, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    try { await pipeline(createReadStream(path.join(this.dir, `${id}.bin`)), res); }
    catch { res.destroy(); } // No JSON error after streaming headers.
  }
}
