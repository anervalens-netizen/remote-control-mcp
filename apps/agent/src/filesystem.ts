import { beginTransfer, finalizeTransfer } from "./transfer-staging.ts";
import { copyPath } from "./filesystem-copy.ts";
import { lstat, mkdir, open, readdir, realpath, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { utf8LeadingCodePointLength, utf8SafeLength } from "./state.ts";
import { captureWindowsDirectRewriteMetadata, cloneExistingMetadata, existingMode, movePath, replaceByRename, restoreWindowsDirectRewriteMetadata, syncContainingDirectory, type WindowsDirectRewriteMetadata } from "./filesystem-atomic.ts";

const DEFAULT_READ_BYTES = 1024 * 1024;
const DEFAULT_LINE_COUNT = 1000;
const READ_CHUNK_BYTES = 64 * 1024;

type FsReadInput = {
  path: string; offset?: number; length?: number; encoding?: "utf8" | "base64";
  tailBytes?: number; startLine?: number; lineCount?: number; maxBytes?: number;
};

type OpenFile = Awaited<ReturnType<typeof open>>;
type SyncableFile = Pick<OpenFile, "stat" | "sync">;
type InPlaceSyncResult = {
  dataSynced: boolean;
  dataSyncSkipped?: boolean;
  dataSyncReason?: "non_regular_target";
  durabilityError?: string;
};

export function isValidBase64Data(value: string): boolean {
  if (value.length === 0) return true;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return false;
  const padding = value.length - unpadded.length;
  if (padding > 0) {
    if (value.length % 4 !== 0) return false;
    const expectedPadding = (4 - (unpadded.length % 4)) % 4;
    if (padding !== expectedPadding) return false;
  }
  return Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === unpadded;
}

function decodeWriteData(input: { data: string; encoding?: "utf8" | "base64" }): Buffer {
  if (input.encoding !== "base64") return Buffer.from(input.data, "utf8");
  if (!isValidBase64Data(input.data)) throw new Error("Invalid Base64 data");
  return Buffer.from(input.data, "base64");
}

export async function syncInPlaceWrite(file: SyncableFile): Promise<InPlaceSyncResult> {
  const descriptor = await file.stat();
  try {
    // Some non-regular targets (notably block devices) support fsync and should
    // retain that durability capability. Only downgrade after the OS actually
    // reports that syncing this special descriptor is unsupported.
    await file.sync();
    return { dataSynced: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!descriptor.isFile() && ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) {
      return {
        dataSynced: false,
        dataSyncSkipped: true,
        dataSyncReason: "non_regular_target",
        durabilityError: error instanceof Error ? error.message : String(error),
      };
    }
    // A real storage/durability failure must remain an operation failure.
    // Downgrading EIO/ENOSPC/etc. to a successful-but-nondurable response would
    // let callers treat data that may not have reached stable storage as done.
    throw error;
  }
}

async function findLineOffset(file: OpenFile, startLine: number): Promise<number> {
  if (startLine <= 1) return 0;
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);
  let position = 0;
  let line = 1;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead <= 0) return position;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) {
        line += 1;
        if (line === startLine) return position + index + 1;
      }
    }
    position += bytesRead;
  }
}

async function readLineRange(file: OpenFile, input: FsReadInput, totalBytes: number) {
  const startLine = input.startLine ?? 1;
  const lineCount = input.lineCount ?? DEFAULT_LINE_COUNT;
  const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
  // In line mode an explicit byte offset is a continuation cursor. This lets
  // callers resume a truncated long line using the returned nextOffset while
  // retaining startLine/nextLine numbering.
  const byteOffset = input.offset ?? await findLineOffset(file, startLine);
  if (byteOffset >= totalBytes) {
    return {
      path: input.path, totalBytes, byteOffset, nextOffset: byteOffset, startLine, nextLine: startLine,
      linesRead: 0, bytesRead: 0, eof: true, truncated: false, partialLine: false, encoding: "utf8" as const, data: "",
    };
  }

  const output: Buffer[] = [];
  let outputBytes = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let position = byteOffset;
  let linesRead = 0;
  const buffer = Buffer.alloc(READ_CHUNK_BYTES);

  const partialResult = () => {
    const joined = Buffer.concat(pending, pendingBytes);
    const room = Math.max(0, maxBytes - outputBytes);
    const raw = joined.subarray(0, room);
    const safeLength = utf8SafeLength(raw);
    const take = safeLength > 0 || raw.length === 0
      ? safeLength
      : Math.min(utf8LeadingCodePointLength(joined), joined.length);
    const partial = joined.subarray(0, take);
    const data = Buffer.concat([...output, partial], outputBytes + partial.length);
    return {
      path: input.path, totalBytes, byteOffset, nextOffset: byteOffset + data.length, startLine, nextLine: startLine + linesRead,
      linesRead, bytesRead: data.length, eof: false, truncated: true, partialLine: partial.length > 0, encoding: "utf8" as const, data: data.toString("utf8"),
    };
  };

  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead <= 0) {
      if (pendingBytes > 0 && linesRead < lineCount) {
        if (outputBytes + pendingBytes > maxBytes) return partialResult();
        output.push(...pending); outputBytes += pendingBytes; linesRead += 1; pending = []; pendingBytes = 0;
      }
      const data = Buffer.concat(output, outputBytes);
      return {
        path: input.path, totalBytes, byteOffset, nextOffset: byteOffset + outputBytes, startLine, nextLine: startLine + linesRead,
        linesRead, bytesRead: outputBytes, eof: true, truncated: false, partialLine: false, encoding: "utf8" as const, data: data.toString("utf8"),
      };
    }

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const segment = Buffer.from(buffer.subarray(segmentStart, index + 1));
      pending.push(segment); pendingBytes += segment.length; segmentStart = index + 1;
      if (outputBytes + pendingBytes > maxBytes) return outputBytes > 0 ? {
        path: input.path, totalBytes, byteOffset, nextOffset: byteOffset + outputBytes, startLine, nextLine: startLine + linesRead,
        linesRead, bytesRead: outputBytes, eof: false, truncated: true, partialLine: false, encoding: "utf8" as const, data: Buffer.concat(output, outputBytes).toString("utf8"),
      } : partialResult();
      output.push(...pending); outputBytes += pendingBytes; pending = []; pendingBytes = 0; linesRead += 1;
      if (linesRead >= lineCount) {
        const data = Buffer.concat(output, outputBytes);
        const nextOffset = byteOffset + outputBytes;
        return {
          path: input.path, totalBytes, byteOffset, nextOffset, startLine, nextLine: startLine + linesRead,
          linesRead, bytesRead: outputBytes, eof: nextOffset >= totalBytes, truncated: false, partialLine: false, encoding: "utf8" as const, data: data.toString("utf8"),
        };
      }
    }
    if (segmentStart < bytesRead) {
      const segment = Buffer.from(buffer.subarray(segmentStart, bytesRead));
      pending.push(segment); pendingBytes += segment.length;
      if (outputBytes + pendingBytes > maxBytes) return outputBytes > 0 ? {
        path: input.path, totalBytes, byteOffset, nextOffset: byteOffset + outputBytes, startLine, nextLine: startLine + linesRead,
        linesRead, bytesRead: outputBytes, eof: false, truncated: true, partialLine: false, encoding: "utf8" as const, data: Buffer.concat(output, outputBytes).toString("utf8"),
      } : partialResult();
    }
    position += bytesRead;
  }
}

export async function fsRead(input: FsReadInput) {
  if (input.tailBytes !== undefined && input.tailBytes < 0) throw new Error("tailBytes must be non-negative");
  if (input.startLine !== undefined && input.startLine < 1) throw new Error("startLine must be >= 1");
  if (input.lineCount !== undefined && input.lineCount < 1) throw new Error("lineCount must be >= 1");
  if (input.maxBytes !== undefined && input.maxBytes < 1) throw new Error("maxBytes must be >= 1");
  const lineMode = input.startLine !== undefined || input.lineCount !== undefined || input.maxBytes !== undefined;
  if (input.tailBytes !== undefined && (input.offset !== undefined || input.length !== undefined || lineMode)) throw new Error("tailBytes cannot be combined with offset/length/line-range options");
  if (lineMode && (input.length !== undefined || input.tailBytes !== undefined)) throw new Error("line-range options cannot be combined with length/tail options");
  if (lineMode && input.encoding === "base64") throw new Error("line-range reads require UTF-8 encoding");
  const file = await open(input.path, "r");
  try {
    const info = await file.stat();
    if (info.size === 0 && (lineMode || (input.tailBytes ?? 0) > 0)) {
      const probe = Buffer.alloc(1);
      const { bytesRead: probeBytes } = await file.read(probe, 0, 1, 0);
      if (probeBytes > 0) {
        const mode = lineMode ? "line-range" : "tailBytes";
        throw new Error(`${mode} requires a known-size file; use byte paging for virtual streams`);
      }
    }
    if (lineMode) return await readLineRange(file, input, info.size);
    if (input.tailBytes !== undefined) {
      const requested = Math.min(Math.max(input.tailBytes, 0), info.size);
      const rawOffset = Math.max(0, info.size - requested);
      const buffer = Buffer.alloc(requested);
      const { bytesRead } = requested > 0 ? await file.read(buffer, 0, requested, rawOffset) : { bytesRead: 0 };
      let start = 0;
      if ((input.encoding ?? "utf8") === "utf8") {
        while (start < bytesRead && start < 3 && (buffer[start]! & 0xc0) === 0x80) start += 1;
      }
      const data = buffer.subarray(start, bytesRead);
      const offset = rawOffset + start;
      return {
        path: input.path, totalBytes: info.size, offset, nextOffset: info.size, bytesRead: data.length, eof: true, tailBytes: input.tailBytes,
        encoding: input.encoding ?? "utf8", data: data.toString(input.encoding ?? "utf8"),
      };
    }
    const offset = Math.max(input.offset ?? 0, 0);
    const knownSize = info.size > 0;
    const available = knownSize ? Math.max(0, info.size - offset) : undefined;
    const requested = input.length ?? DEFAULT_READ_BYTES;
    const toRead = available === undefined ? requested : Math.min(requested, available);
    const buffer = Buffer.alloc(Math.max(toRead, 0));
    const { bytesRead: rawBytesRead } = toRead > 0 ? await file.read(buffer, 0, toRead, offset) : { bytesRead: 0 };
    let bytesRead = rawBytesRead;
    const moreBytesMayExist = knownSize ? offset + rawBytesRead < info.size : rawBytesRead === toRead;
    if (input.length === undefined && (input.encoding ?? "utf8") === "utf8" && rawBytesRead > 0 && moreBytesMayExist) {
      bytesRead = utf8SafeLength(buffer.subarray(0, rawBytesRead));
    }
    const data = buffer.subarray(0, bytesRead);
    const nextOffset = offset + bytesRead;
    // Virtual files often report stat.size=0. In that case totalBytes is the
    // amount discovered so far and EOF is known only when a bounded read is short.
    const totalBytes = knownSize ? info.size : nextOffset;
    const eof = knownSize ? nextOffset >= info.size : rawBytesRead < toRead;

    return {
      path: input.path, totalBytes, offset, nextOffset, bytesRead: data.length, eof,
      encoding: input.encoding ?? "utf8",
      data: data.toString(input.encoding ?? "utf8"),
    };
  } finally {
    await file.close();
  }
}

export async function fsWrite(input: { path: string; data: string; encoding?: "utf8" | "base64"; mode?: "rewrite" | "append"; createParents?: boolean; permissions?: number }) {
  // Decode and validate before any filesystem mutation, including parent creation.
  const data = decodeWriteData(input);
  if (input.createParents) await mkdir(path.dirname(input.path), { recursive: true });

  if (input.mode === "append") {
    let targetExisted = true;
    try { await stat(input.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") targetExisted = false;
      else throw error;
    }
    const file = await open(input.path, "a", input.permissions ?? 0o666);
    let writeSync: InPlaceSyncResult;
    try {
      await file.writeFile(data);
      writeSync = await syncInPlaceWrite(file);
    } finally { await file.close(); }
    let directorySync: { synced: boolean; error?: string } | undefined;
    if (!targetExisted && process.platform !== "win32") {
      let durabilityTarget = input.path;
      try { durabilityTarget = await realpath(input.path); } catch { /* direct path fallback */ }
      directorySync = await syncContainingDirectory(durabilityTarget);
    }
    const info = await stat(input.path);
    return {
      path: input.path, bytes: info.size, writtenBytes: data.length, mode: "append", atomic: false,
      durable: writeSync.dataSynced && (process.platform === "win32" || targetExisted || directorySync?.synced === true),
      created: !targetExisted,
      ...writeSync,
      ...(directorySync ? { directorySynced: directorySync.synced } : {}),
      ...(directorySync?.error ? { durabilityError: directorySync.error } : {}),
    };
  }

  let existingEntry: Awaited<ReturnType<typeof lstat>> | undefined;
  try { existingEntry = await lstat(input.path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existingEntry && !existingEntry.isFile()) {
    const file = await open(input.path, "w");
    let writeSync: InPlaceSyncResult;
    try {
      await file.writeFile(data);
      writeSync = await syncInPlaceWrite(file);
    } finally { await file.close(); }
    const info = await stat(input.path);
    return {
      path: input.path, bytes: info.size, writtenBytes: data.length, mode: "rewrite",
      atomic: false, durable: writeSync.dataSynced, replacedExisting: true, directTarget: true,
      targetType: existingEntry.isSymbolicLink() ? "symlink" : existingEntry.isDirectory() ? "directory" : "special",
      ...writeSync,
    };
  }

  const parsed = path.parse(input.path);
  const temporary = path.join(parsed.dir, `.rcmcp-write-${randomUUID()}.tmp`);
  const preservedMode = await existingMode(input.path);
  let activated = false;
  let stagedFile: OpenFile | undefined;
  try {
    stagedFile = await open(temporary, "wx", preservedMode ?? input.permissions ?? 0o666);
    await stagedFile.writeFile(data);
    await stagedFile.sync();
    // Retain the original POSIX descriptor across metadata cloning: reopening
    // can fail after restoring readonly/no-access modes despite legal rename.
    if (process.platform === "win32") { await stagedFile.close(); stagedFile = undefined; }

    let metadataStrategy: "posix-all" | "windows-full" | "basic" | "direct-existing" | "none" = "none";
    let directFallback = false;
    let windowsDirectMetadata: WindowsDirectRewriteMetadata | null = null;
    if (existingEntry?.isFile()) {
      metadataStrategy = await cloneExistingMetadata(input.path, temporary);
      if (metadataStrategy === "posix-all") {
        const cloned = await stat(temporary);
        await utimes(temporary, cloned.atime, new Date());
      }
      if (process.platform === "win32" && metadataStrategy !== "windows-full") {
        // Special Windows metadata that cannot be cloned safely (for example EFS
        // encryption or sparse allocation) must stay on the original file record.
        windowsDirectMetadata = await captureWindowsDirectRewriteMetadata(input.path);
        directFallback = true;
      }
      if (metadataStrategy !== "windows-full") {
        const metadataFile = stagedFile ?? await open(temporary, "a");
        try {
          if (metadataStrategy === "none" && process.platform !== "win32") {
            try {
              await metadataFile.chown(Number(existingEntry.uid), Number(existingEntry.gid));
              await metadataFile.chmod(Number(existingEntry.mode));
              metadataStrategy = "basic";
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "EPERM" || code === "EACCES") directFallback = true;
              else throw error;
            }
          }
          // POSIX metadata such as security.capability can be cleared by the
          // content write itself, so clone metadata after writing and sync again.
          await metadataFile.sync();
        } finally { if (metadataFile !== stagedFile) await metadataFile.close(); }
      }
    }

    if (stagedFile) { await stagedFile.close(); stagedFile = undefined; }

    if (directFallback && existingEntry?.isFile()) {
      const direct = await open(input.path, "w");
      try { await direct.writeFile(data); await direct.sync(); } finally { await direct.close(); }
      if (windowsDirectMetadata) await restoreWindowsDirectRewriteMetadata(input.path, windowsDirectMetadata);
      const after = await stat(input.path);
      return {
        path: input.path, bytes: after.size, writtenBytes: data.length, mode: "rewrite", atomic: false, durable: true,
        replacedExisting: true, directTarget: true, targetType: "file",
        metadataPreserved: process.platform === "win32", metadataStrategy: "direct-existing",
        ownershipPreserved: after.uid === existingEntry.uid && after.gid === existingEntry.gid,
      };
    }

    const activation = await replaceByRename(temporary, input.path, true);
    activated = true;
    const directorySync = await syncContainingDirectory(input.path);
    const info = await stat(input.path);
    return {
      path: input.path, bytes: info.size, writtenBytes: data.length, mode: "rewrite",
      atomic: activation.atomic,
      durable: process.platform === "win32" ? true : directorySync.synced,
      directorySynced: directorySync.synced,
      ...(directorySync.error ? { durabilityError: directorySync.error } : {}),
      metadataPreserved: metadataStrategy === "posix-all" || metadataStrategy === "windows-full",
      metadataStrategy,
      replacedExisting: activation.replacedExisting || preservedMode !== undefined,
      ...(activation.cleanupPending ? {
        cleanupPending: true, cleanupPath: activation.cleanupPath, cleanupError: activation.cleanupError,
      } : {}),
    };
  } finally {
    await stagedFile?.close().catch(() => undefined);
    if (!activated) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function fsList(input: { path: string }) {
  const entries = await readdir(input.path, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(input.path, entry.name);
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other";
    try {
      // lstat describes the directory entry itself and therefore works for a
      // dangling symlink instead of failing the whole directory listing.
      const info = await lstat(fullPath);
      return {
        name: entry.name, path: fullPath, type,
        size: info.size, modifiedAt: info.mtime.toISOString(), mode: info.mode,
      };
    } catch (error) {
      return {
        name: entry.name, path: fullPath, type,
        size: 0, modifiedAt: null, mode: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

export async function fsManage(input: {
  operation: "stat" | "mkdir" | "move" | "copy" | "delete" | "times" | "transfer-stage" | "transfer-finalize";
  path: string;
  destination?: string;
  recursive?: boolean;
  force?: boolean;
  modifiedAt?: string;
  accessedAt?: string;
  expectedDestination?: string; expectedBytes?: number; sourceMode?: number;
}, signal?: AbortSignal) {
  switch (input.operation) {
    case "transfer-stage": return { ...await beginTransfer(input.path, signal) };
    case "transfer-finalize":
      if (!input.destination || input.expectedDestination === undefined || input.expectedBytes === undefined) throw new Error("Missing transfer finalization metadata");
      return { ...await finalizeTransfer({ ...input, destination: input.destination, expectedDestination: input.expectedDestination, expectedBytes: input.expectedBytes }, signal) };
    case "stat": {
      const info = await stat(input.path);
      return {
        path: input.path,
        size: info.size,
        mode: info.mode,
        posixMode: process.platform === "win32" ? null : info.mode & 0o777,
        uid: info.uid,
        gid: info.gid,
        dev: info.dev,
        ino: info.ino,
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        createdAt: info.birthtime.toISOString(),
        modifiedAt: info.mtime.toISOString(),
      };
    }
    case "mkdir":
      await mkdir(input.path, { recursive: input.recursive ?? true });
      return { ok: true, operation: input.operation, path: input.path };
    case "move": {
      if (!input.destination) throw new Error("destination is required for move");
      const result = await movePath(input.path, input.destination, input.force ?? false);
      return { ...result, operation: input.operation, path: input.path, destination: input.destination };
    }
    case "copy":
      if (!input.destination) throw new Error("destination is required for copy");
      return { ...await copyPath(input.path, input.destination, input.recursive ?? true, input.force ?? true, signal), operation: input.operation, path: input.path, destination: input.destination };
    case "delete":
      await rm(input.path, { recursive: input.recursive ?? true, force: input.force ?? true });
      return { ok: true, operation: input.operation, path: input.path };
    case "times": {
      if (!input.modifiedAt && !input.accessedAt) throw new Error("modifiedAt or accessedAt is required for times");
      const before = await stat(input.path);
      const accessedAt = input.accessedAt ? new Date(input.accessedAt) : before.atime;
      const modifiedAt = input.modifiedAt ? new Date(input.modifiedAt) : before.mtime;
      if (!Number.isFinite(accessedAt.getTime()) || !Number.isFinite(modifiedAt.getTime())) throw new Error("Invalid timestamp");
      await utimes(input.path, accessedAt, modifiedAt);
      let metadataSynced = false;
      let metadataSyncError: string | undefined;
      if (before.isFile()) {
        let file;
        try {
          // Descriptor fsync is meaningful for regular files. Opening FIFOs,
          // devices, sockets or directories merely to fsync metadata can block
          // or fail after utimes has already succeeded.
          file = await open(input.path, process.platform === "win32" ? "r+" : "r");
          await file.sync();
          metadataSynced = true;
        } catch (error) {
          metadataSyncError = error instanceof Error ? error.message : String(error);
        } finally { await file?.close(); }
      }
      const directorySync = before.isFile() ? await syncContainingDirectory(input.path) : undefined;
      const after = await stat(input.path);
      return {
        ok: true, operation: input.operation, path: input.path,
        accessedAt: after.atime.toISOString(), modifiedAt: after.mtime.toISOString(),
        durable: metadataSynced && (process.platform === "win32" || !before.isFile() || directorySync?.synced === true),
        metadataSynced,
        ...(!before.isFile() ? { metadataSyncSkipped: true, metadataSyncReason: "non_regular_target" } : {}),
        ...(directorySync ? { directorySynced: directorySync.synced } : {}),
        ...((metadataSyncError || directorySync?.error) ? { durabilityError: metadataSyncError ?? directorySync?.error } : {}),
      };
    }
  }
}
