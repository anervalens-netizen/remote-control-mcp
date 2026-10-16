import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./state.ts";

export class ExecReceiptError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, statusCode: number, message: string) { super(message); this.code = code; this.statusCode = statusCode; }
}

const metadata = z.object({ id: z.string().uuid(), createdAt: z.number(), expiresAt: z.number() });
export class ExecReceiptStore {
  private active = new Set<string>();
  readonly root: string;
  readonly maxEntries: number;
  readonly maxResultBytes: number;
  readonly retentionMs: number;
  constructor(root: string, maxEntries = 64, maxResultBytes = 1024 * 1024, retentionMs = 24 * 60 * 60 * 1000) {
    this.root = root; this.maxEntries = maxEntries; this.maxResultBytes = maxResultBytes; this.retentionMs = retentionMs;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private directory(id: string) { return path.join(this.root, z.string().uuid().parse(id)); }
  private syncDirectory(dir: string) {
    if (process.platform !== "win32") { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  private load(id: string) {
    const dir = this.directory(id);
    try {
      const value = metadata.parse(JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8")));
      if (value.id !== id) throw new Error("mismatch");
      return value;
    } catch { throw new ExecReceiptError("exec_receipt_unavailable", 404, "Exec receipt unavailable; absence never authorizes replay"); }
  }
  prepare() {
    // Never remove incomplete claimed executions: absence of a result is not
    // proof of termination, including after an agent restart.
    for (const id of readdirSync(this.root)) {
      if (!z.string().uuid().safeParse(id).success || this.active.has(id)) continue;
      try {
        const entry = this.load(id), dir = this.directory(id);
        if (entry.expiresAt <= Date.now() && (!existsSync(path.join(dir, "claimed")) || existsSync(path.join(dir, "result.json")))) rmSync(dir, { recursive: true });
      } catch { /* Corrupt reservations consume capacity and fail closed. */ }
    }
    if (readdirSync(this.root).length >= this.maxEntries) {
      const completed = readdirSync(this.root).flatMap(id => {
        if (!z.string().uuid().safeParse(id).success || this.active.has(id)) return [];
        try { const entry = this.load(id); return existsSync(path.join(this.directory(id), "result.json")) ? [entry] : []; }
        catch { return []; }
      }).sort((a, b) => a.createdAt - b.createdAt);
      if (completed[0]) rmSync(this.directory(completed[0].id), { recursive: true });
    }
    if (readdirSync(this.root).length >= this.maxEntries) throw new ExecReceiptError("exec_receipt_capacity", 507, "Exec receipt capacity full; no dispatch occurred");
    const id = randomUUID(), dir = this.directory(id), now = Date.now();
    mkdirSync(dir, { mode: 0o700 });
    atomicWriteJson(path.join(dir, "meta.json"), { id, createdAt: now, expiresAt: now + this.retentionMs });
    this.syncDirectory(this.root);
    return { id, scope: "agent_disk", noReplay: true, expiresAt: new Date(now + this.retentionMs).toISOString() };
  }
  async execute<T>(id: string, run: () => Promise<T>): Promise<T> {
    const entry = this.load(id), dir = this.directory(id);
    if (entry.expiresAt <= Date.now()) throw new ExecReceiptError("exec_receipt_expired", 409, "Exec reservation expired; no dispatch occurred");
    // Cross-process exclusive claim is durable BEFORE the command starts.
    // A duplicate always refuses execution, even if the original has finished.
    try { mkdirSync(path.join(dir, "claimed"), { mode: 0o700 }); }
    catch { throw new ExecReceiptError("exec_receipt_consumed", 409, "Exec reservation already used or unavailable; recover without replay"); }
    this.syncDirectory(dir);
    this.active.add(id);
    try {
      const result = await run();
      const serialized = JSON.stringify(result);
      const payload = Buffer.byteLength(serialized) <= this.maxResultBytes ? result : {
        receiptUnavailable: true, reason: "exec_receipt_byte_budget", originalBytes: Buffer.byteLength(serialized), noReplay: true,
      };
      atomicWriteJson(path.join(dir, "result.json"), payload);
      return result;
    } catch (error) {
      // Do not claim failure-before-effects. The runner or persistence may fail
      // after dispatch; a claimed receipt with no result stays uncertain.
      throw error;
    } finally { this.active.delete(id); }
  }
  read(id: string, offset = 0, length = 12 * 1024) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 12 * 1024) throw new Error("Invalid receipt page");
    const entry = this.load(id), dir = this.directory(id), result = path.join(dir, "result.json");
    if (entry.expiresAt <= Date.now() && !this.active.has(id) && (!existsSync(path.join(dir, "claimed")) || existsSync(result))) {
      rmSync(dir, { recursive: true });
      throw new ExecReceiptError("exec_receipt_expired", 410, "Exec receipt expired; retained output unavailable; absence never authorizes replay");
    }
    const reference = { id, scope: "agent_disk", noReplay: true, expiresAt: new Date(entry.expiresAt).toISOString() };
    if (!existsSync(result)) return { ...reference, state: this.active.has(id) ? "running" : existsSync(path.join(dir, "claimed")) ? "unknown" : "reserved" };
    const fd = openSync(result, "r");
    try {
      const totalBytes = statSync(result).size;
      const data = Buffer.alloc(Math.min(length, Math.max(0, totalBytes - offset)));
      const bytesRead = readSync(fd, data, 0, data.length, Math.min(offset, totalBytes));
      return { ...reference, state: "complete", encoding: "base64", mediaType: "application/json", offset, bytesRead,
        nextOffset: offset + bytesRead, totalBytes, eof: offset + bytesRead >= totalBytes, data: data.subarray(0, bytesRead).toString("base64") };
    } finally { closeSync(fd); }
  }
}
