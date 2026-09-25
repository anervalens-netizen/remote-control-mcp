import type { BigIntStats } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { beginTransfer, finalizeTransfer } from "./transfer-staging.ts";
import { DEFAULT_TRANSFER_TIMEOUT_MS, createDeadline } from "../../../packages/protocol/src/deadline.ts";

export type DirectTransferInput = {
  sourceBase: string;
  sourceToken?: string;
  sourcePath: string;
  destinationPath: string;
  timeoutMs?: number;
  expectedBytes?: number;
  expectedModifiedAt?: string;
  preserveTimestamps?: boolean;
};

// Retain only bounded digest metadata, never a payload or an open descriptor.
// A final HEAD may reuse the initial digest only for the exact same identity,
// size, modification and change times. Changed/evicted entries are rehashed.
const rawDigestCache = new Map<string, { signature: string; sha256: string; expiresAt: number }>();
const RAW_DIGEST_CACHE_LIMIT = 128;
const RAW_DIGEST_CACHE_TTL_MS = 2 * 60 * 60 * 1000 + 60_000;
function fileSignature(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function openRawFile(pathname: string, options: { metadataOnly?: boolean; signal?: AbortSignal } = {}) {
  const cacheKey = path.resolve(pathname);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    options.signal?.throwIfAborted();
    const file = await open(pathname, "r");
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) throw new Error("Source is not a regular file");
      const size = Number(info.size);
      if (!Number.isSafeInteger(size)) throw new Error("Source file size exceeds the supported byte range");
      const signature = fileSignature(info);
      const cached = options.metadataOnly ? rawDigestCache.get(cacheKey) : undefined;
      let sha256: string;
      if (cached && cached.expiresAt > Date.now() && cached.signature === signature) {
        sha256 = cached.sha256;
      } else {
        const hash = createHash("sha256");
        if (size > 0) {
          const hashingStream = file.createReadStream({ start: 0, end: size - 1, autoClose: false, signal: options.signal });
          for await (const chunk of hashingStream) hash.update(chunk);
        }
        sha256 = hash.digest("hex");
      }
      options.signal?.throwIfAborted();
      const after = await file.stat({ bigint: true });
      const current = await stat(pathname, { bigint: true });
      if (fileSignature(after) !== signature || fileSignature(current) !== signature) continue;
      // Preserve the same Date rounding as fs_manage/stat. BigIntStats truncate
      // milliseconds, while numeric Stats Date can round a fractional value.
      const publicInfo = await file.stat();
      if (fileSignature(await file.stat({ bigint: true })) !== signature) continue;
      rawDigestCache.delete(cacheKey);
      rawDigestCache.set(cacheKey, { signature, sha256, expiresAt: Date.now() + RAW_DIGEST_CACHE_TTL_MS });
      while (rawDigestCache.size > RAW_DIGEST_CACHE_LIMIT) rawDigestCache.delete(rawDigestCache.keys().next().value!);
      const modifiedAt = publicInfo.mtime.toISOString();
      const posixMode = process.platform === "win32" ? undefined : publicInfo.mode & 0o777;
      if (options.metadataOnly) return { size, modifiedAt, sha256, posixMode, stream: Readable.from([]) };
      const streamFile = await open(pathname, "r");
      const streamInfo = await streamFile.stat({ bigint: true });
      if (fileSignature(streamInfo) !== signature) {
        await streamFile.close();
        continue;
      }
      return {
        size, modifiedAt, sha256, posixMode,
        stream: size === 0
          ? (await streamFile.close(), Readable.from([]))
          : streamFile.createReadStream({ start: 0, end: size - 1, autoClose: true }),
      };
    } finally {
      await file.close().catch(() => undefined);
    }
  }
  throw new Error("Source changed while preparing direct transfer");
}

async function confirmRemoteSource(source: URL, headers: Record<string, string>, expected: { size: number; modifiedAt: string | null; sha256: string; posixMode?: number }, signal: AbortSignal | undefined) {
  const response = await fetch(source, { method: "HEAD", headers, signal, redirect: "error" });
  if (!response.ok) throw new Error(`Direct source confirmation failed: HTTP ${response.status}`);
  const size = Number(response.headers.get("content-length"));
  const modifiedAt = response.headers.get("x-rcmcp-modified-at");
  const sha256 = response.headers.get("x-rcmcp-sha256");
  const posixMode = response.headers.get("x-rcmcp-posix-mode");
  if ((expected.posixMode !== undefined && (posixMode === null || Number(posixMode) !== expected.posixMode)) || size !== expected.size || modifiedAt !== expected.modifiedAt || sha256?.toLowerCase() !== expected.sha256) {
    throw new Error("Source changed during direct transfer before activation");
  }
}

export async function receiveDirectTransfer(input: DirectTransferInput, externalSignal?: AbortSignal) {
  const started = performance.now();
  let stage: Awaited<ReturnType<typeof beginTransfer>> | undefined;
  const source = new URL("/v1/fs/raw", input.sourceBase);
  source.searchParams.set("path", input.sourcePath);
  const deadline = createDeadline(input.timeoutMs, externalSignal, DEFAULT_TRANSFER_TIMEOUT_MS);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  const signal = deadline.signal;
  let activated = false;
  let response: Response | undefined;
  let completedReceipt: { cleanupPending?: boolean; cleanupPath?: string; cleanupError?: string } | undefined;
  let operationError: unknown;
  try {
    signal?.throwIfAborted();
    stage = await beginTransfer(input.destinationPath, signal);
    const temporary = stage.temporaryPath;
    const headers: Record<string, string> = {};
    if (input.sourceToken) headers.authorization = `Bearer ${input.sourceToken}`;
    response = await fetch(source, { headers, signal, redirect: "error" });
    if (!response.ok) throw new Error(`Direct source transfer failed: HTTP ${response.status}`);
    if (!response.body) throw new Error("Direct source transfer returned no response body");
    const lengthHeader = response.headers.get("content-length");
    const expectedBytes = lengthHeader === null ? NaN : Number(lengthHeader);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error("Invalid direct source content-length");
    if (input.expectedBytes !== undefined && input.expectedBytes !== expectedBytes) throw new Error("Source size changed before direct transfer");
    const mtimeHeader = response.headers.get("x-rcmcp-modified-at");
    const modifiedAt = mtimeHeader && Number.isFinite(Date.parse(mtimeHeader)) ? new Date(mtimeHeader) : null;
    const sourceHash = response.headers.get("x-rcmcp-sha256");
    if (sourceHash !== null && !/^[a-f0-9]{64}$/i.test(sourceHash)) throw new Error("Invalid direct source SHA-256");
    if (input.expectedModifiedAt !== undefined && input.expectedModifiedAt !== modifiedAt?.toISOString()) throw new Error("Source timestamp changed before direct transfer");
    const modeHeader = response.headers.get("x-rcmcp-posix-mode");
    const sourceMode = modeHeader === null ? undefined : Number(modeHeader);
    if (sourceMode !== undefined && (!Number.isInteger(sourceMode) || sourceMode < 0 || sourceMode > 0o777)) throw new Error("Invalid source POSIX mode");
    const file = await open(temporary, "r+");
    let bytes = 0;
    let receivedHash = "";
    const hash = createHash("sha256");
    try {
      for await (const chunk of response.body) {
        signal?.throwIfAborted();
        const buffer = Buffer.from(chunk);
        if (!buffer.length) continue;
        await file.writeFile(buffer);
        bytes += buffer.length;
        hash.update(buffer);
      }
      if (bytes !== expectedBytes) throw new Error(`Direct transfer size mismatch: expected ${expectedBytes}, got ${bytes}`);
      receivedHash = hash.digest("hex");
      if (sourceHash !== null && receivedHash !== sourceHash.toLowerCase()) throw new Error("Source content changed during direct transfer");
      if (response.headers.get("x-rcmcp-source-confirmation") === "head") {
        await confirmRemoteSource(source, headers, { size: expectedBytes, modifiedAt: modifiedAt?.toISOString() ?? null, sha256: receivedHash, posixMode: sourceMode }, signal);
      }
      if (input.preserveTimestamps !== false && modifiedAt) await file.utimes(new Date(), modifiedAt);
      await file.sync();
    } finally { await file.close(); }
    signal?.throwIfAborted();
    const staged = await stat(temporary);
    if (staged.size !== bytes) throw new Error("Direct transfer staging size mismatch");
    const activation = await finalizeTransfer({ path: temporary, destination: input.destinationPath,
      expectedDestination: stage.expectedDestination, expectedBytes: bytes, sourceMode }, signal);
    activated = true;
    const destination = await stat(input.destinationPath);
    const receipt = {
      transport: "direct-agent-binary", bytes, chunks: 0, sameFile: false,
      sha256: receivedHash,
      sourceVerification: response.headers.get("x-rcmcp-source-confirmation") === "head" ? "hash-and-final-confirmation" : sourceHash ? "initial-hash-only" : "legacy-size-only",
      sourceStableVerified: response.headers.get("x-rcmcp-source-confirmation") === "head",
      ...activation,
      modifiedAt: modifiedAt?.toISOString() ?? null,
      modifiedAtPreserved: input.preserveTimestamps !== false && modifiedAt !== null && Math.abs(destination.mtimeMs - modifiedAt.getTime()) < 2,
      durationMs: Math.round(performance.now() - started),
    };
    completedReceipt = receipt;
    return receipt;
  } catch (error) {
    operationError = !activated && externalSignal?.aborted && !deadline.timedOut() ? new Error("Direct source transfer cancelled by caller")
      : !activated && deadline.timedOut() ? new Error(`Direct source transfer timed out after ${timeoutMs}ms`) : error;
    throw operationError;
  } finally {
    deadline.dispose();
    await response?.body?.cancel().catch(() => undefined);
    if (stage) {
      try {
        await rm(stage.directory, { recursive: true, force: true });
        if (completedReceipt?.cleanupPath === stage.temporaryPath) {
          delete completedReceipt.cleanupPending; delete completedReceipt.cleanupPath; delete completedReceipt.cleanupError;
        }
      } catch (error) {
        const cleanupError = error instanceof Error ? error.message : String(error);
        if (completedReceipt) Object.assign(completedReceipt, { cleanupPending: true, cleanupPath: stage.directory, cleanupError });
        else if (operationError instanceof Error) operationError.message += `; cleanup pending at ${stage.directory}: ${cleanupError}`;
      }
    }
  }
}
