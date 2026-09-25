import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const stateRoot = process.env.RCMCP_STATE_DIR ?? path.join(os.homedir(), ".remote-control-mcp");

export function ensureStateDir(name: string): string {
  const dir = path.join(stateRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function atomicWriteText(target: string, data: string, mode = 0o600): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.rcmcp-state-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  let committed = false;
  let stage = "open";
  try {
    fd = openSync(temporary, "wx", mode);
    created = true;
    stage = "write";
    writeFileSync(fd, data, { encoding: "utf8" });
    stage = "file-sync";
    fsyncSync(fd);
    stage = "close";
    const completedFd = fd; fd = undefined;
    closeSync(completedFd);
    stage = "rename";
    renameSync(temporary, target);
    committed = true;
    if (process.platform !== "win32") {
      stage = "directory-sync";
      const dirFd = openSync(path.dirname(target), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch (cause) {
    const cleanupErrors: string[] = [];
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (created && !committed) {
      try { rmSync(temporary, { force: true }); } catch (error) { cleanupErrors.push(String(error)); }
    }
    const error = cause instanceof Error ? cause : new Error(String(cause));
    Object.assign(error, { stateWrite: { stage, committed, target, temporary, cleanupErrors } });
    throw error;
  }
}

export function atomicWriteJson(target: string, value: unknown): void {
  atomicWriteText(target, `${JSON.stringify(value)}\n`);
}

export function utf8SafeLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let start = buffer.length - 1;
  let continuation = 0;
  while (start > 0 && continuation < 3 && (buffer[start]! & 0xc0) === 0x80) {
    start -= 1;
    continuation += 1;
  }
  const lead = buffer[start]!;
  const expected = lead <= 0x7f ? 1
    : lead >= 0xc2 && lead <= 0xdf ? 2
      : lead >= 0xe0 && lead <= 0xef ? 3
        : lead >= 0xf0 && lead <= 0xf4 ? 4
          : 1;
  return expected > buffer.length - start ? start : buffer.length;
}

export function utf8LeadingCodePointLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const lead = buffer[0]!;
  if (lead <= 0x7f) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}
