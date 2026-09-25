import { randomUUID } from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentContext, AgentRequestOptions } from "./agent-client.ts";
import { mapLimit } from "./concurrency.ts";
import { DEFAULT_TRANSFER_TIMEOUT_MS, createDeadline, timeoutMsField } from "../../../packages/protocol/src/deadline.ts";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
type StatResult = { posixMode?: number | null; size: number; isFile: boolean; isDirectory?: boolean; dev?: number; ino?: number; modifiedAt?: string };
type ReadResult = { data: string; bytesRead: number };
type ListEntry = { name: string; path: string; type: "directory" | "file" | "symlink" | "other"; size: number; modifiedAt?: string; error?: string };
type Info = { platform?: string; runtime?: { transferStagingVersion?: number } };
type CleanupReceipt = { cleanupPending?: boolean; cleanupPath?: string; cleanupError?: string };
type MoveResult = { ok?: boolean; error?: string; atomic?: boolean; destinationAtomic?: boolean } & CleanupReceipt;
const legacyWarning = "Explicit legacy-agent compatibility: destination permissions/ACLs/executable bits are not guaranteed preserved. Upgrade source and destination agents for private metadata-preserving transfers.";
function supportsPrivateStage(info: Info) { return (info.runtime?.transferStagingVersion ?? 0) >= 1; }
function requireTransferCapability(info: Info, allowLegacyAgent?: boolean, role: "Source" | "Destination" = "Destination") {
  if (!supportsPrivateStage(info) && allowLegacyAgent !== true) throw new Error(`${role} agent lacks private metadata transfer protocol. Upgrade that agent first, or explicitly set allowLegacyAgent=true to use its legacy metadata-limited behavior. No destination mutation was requested.`);
}

function deadlineOptions(deadline: ReturnType<typeof createDeadline>): AgentRequestOptions {
  const timeoutMs = deadline.remainingMs();
  return { signal: deadline.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

function destinationSegments(relative: string, destinationPlatform: string | undefined, sourcePlatform: string | undefined): string[] {
  if (destinationPlatform === "win32") return relative.split(/[\\/]+/g).filter(Boolean);
  return relative.split(sourcePlatform === "win32" ? "\\" : path.posix.sep).filter(Boolean);
}

function windowsNameKey(component: string): string {
  return component.replace(/[ .]+$/g, "").toLowerCase();
}

/** Validate all relative paths before the first destination mutation. */
export function validateDestinationPaths(relativePaths: Array<string | { relative: string; file: boolean }>, destinationPlatform: string | undefined): void {
  if (destinationPlatform !== "win32") return;
  type Entry = { relative: string; file: boolean };
  type Node = { children: Map<string, Node>; entry?: Entry; descendant?: Entry };
  const root: Node = { children: new Map() };
  for (const entry of relativePaths) {
    const relative = typeof entry === "string" ? entry : entry.relative;
    const segments = relative.split(/[\\/]+/g).filter(Boolean);
    if (!segments.length) throw new Error("Invalid empty destination path component");
    for (const component of segments) {
      if (component === "." || component === ".." || /[<>:\"/\\|?*\u0000-\u001f]/.test(component) || /[ .]$/.test(component)) {
        throw new Error(`Invalid Windows destination name in ${relative}: ${component}`);
      }
      const reserved = component.split(".", 1)[0]!.toUpperCase();
      if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(reserved)) {
        throw new Error(`Invalid Windows reserved destination name in ${relative}: ${component}`);
      }
    }
    const current = { relative, file: typeof entry === "string" ? true : entry.file };
    let node = root;
    const ancestors: Node[] = [];
    for (const segment of segments) {
      if (node.entry?.file) {
        throw new Error(`Windows destination path collision: ${node.entry.relative} conflicts with ${relative}`);
      }
      ancestors.push(node);
      const key = windowsNameKey(segment);
      let child = node.children.get(key);
      if (!child) {
        child = { children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    const conflict = node.entry ?? (current.file ? node.descendant : undefined);
    if (conflict) throw new Error(`Windows destination path collision: ${conflict.relative} conflicts with ${relative}`);
    node.entry = current;
    // One traversal per path: never compare this path with every prior entry.
    for (const ancestor of ancestors) ancestor.descendant ??= current;
  }
}

export async function transferFile(client: AgentClient, input: {
  sourceDevice: string; sourcePath: string; destinationDevice: string; destinationPath: string; chunkBytes?: number;
  sourceContext?: AgentContext; destinationContext?: AgentContext; destinationPlatform?: string; destinationSupportsPrivateStage?: boolean; sourceSupportsTransferMetadata?: boolean;
  transport?: "relay" | "direct"; timeoutMs?: number; preserveTimestamps?: boolean; allowLegacyAgent?: boolean; signal?: AbortSignal;
}) {
  const started = performance.now();
  const { signal: callerSignal, destinationSupportsPrivateStage: _privateStage, sourceSupportsTransferMetadata: _sourceMetadata, ...publicInput } = input;
  const deadline = createDeadline(input.timeoutMs, callerSignal, DEFAULT_TRANSFER_TIMEOUT_MS);
  const signal = deadline.signal;
  const requestOptions = () => deadlineOptions(deadline);
  try {
    signal?.throwIfAborted();
    const sourceContext = input.sourceContext ?? "system";
    const destinationContext = input.destinationContext ?? "system";
    const [stat, destinationInfo, sourceInfo] = await Promise.all([
      client.fsManage(input.sourceDevice, { operation: "stat", path: input.sourcePath }, sourceContext, requestOptions()) as Promise<StatResult>,
      input.destinationPlatform === undefined || input.destinationSupportsPrivateStage === undefined ? client.info(input.destinationDevice, destinationContext, requestOptions()) as Promise<Info> : Promise.resolve({ platform: input.destinationPlatform, runtime: { transferStagingVersion: input.destinationSupportsPrivateStage ? 1 : 0 } } as Info),
      input.sourceSupportsTransferMetadata === undefined ? client.info(input.sourceDevice, sourceContext, requestOptions()) as Promise<Info> : Promise.resolve({ runtime: { transferStagingVersion: input.sourceSupportsTransferMetadata ? 1 : 0 } } as Info),
    ]);
    if (!stat.isFile) throw new Error(`Source is not a file: ${input.sourcePath}`);

    if (input.sourceDevice.toLowerCase() === input.destinationDevice.toLowerCase()) {
      if (sourceContext === destinationContext && input.sourcePath === input.destinationPath) {
        return { ...publicInput, bytes: stat.size, chunks: 0, sameFile: true, atomic: true, durationMs: Math.round(performance.now() - started) };
      }
      try {
        const destinationStat = await client.fsManage(input.destinationDevice, { operation: "stat", path: input.destinationPath }, destinationContext, requestOptions()) as StatResult;
        if (stat.dev !== undefined && stat.ino !== undefined && destinationStat.dev === stat.dev && destinationStat.ino === stat.ino) {
          return { ...publicInput, bytes: stat.size, chunks: 0, sameFile: true, atomic: true, durationMs: Math.round(performance.now() - started) };
        }
      } catch { /* destination may not exist yet */ }
    }

    requireTransferCapability(destinationInfo, input.allowLegacyAgent);
    requireTransferCapability(sourceInfo, input.allowLegacyAgent, "Source");
    const modern = supportsPrivateStage(destinationInfo);
    const legacy = !modern || !supportsPrivateStage(sourceInfo);
    if (input.transport === "direct") {
      const timeoutMs = deadline.remainingMs();
      const result = await client.directTransfer(input.sourceDevice, input.destinationDevice, {
        sourcePath: input.sourcePath, destinationPath: input.destinationPath,
        expectedBytes: stat.size,
        ...(stat.modifiedAt === undefined ? {} : { expectedModifiedAt: stat.modifiedAt }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        preserveTimestamps: input.preserveTimestamps ?? true,
      }, sourceContext, destinationContext, signal);
      if (!result.ok) throw new Error("Direct transfer did not complete successfully");
      return { ...publicInput, ...result, ...(legacy ? { legacyAgent: true, metadataPreserved: false, compatibilityWarning: legacyWarning } : {}), durationMs: Math.round(performance.now() - started) };
    }

    const chunk = input.chunkBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(chunk) || chunk <= 0) throw new Error("chunkBytes must be positive");
    const legacyTemporary = (destinationInfo.platform === "win32" ? path.win32 : path.posix).join(
      (destinationInfo.platform === "win32" ? path.win32 : path.posix).dirname(input.destinationPath), `.rcmcp-transfer-${randomUUID()}.tmp`);
    const stage = modern
      ? await client.fsManage(input.destinationDevice, { operation: "transfer-stage", path: input.destinationPath, timeoutMs: deadline.remainingMs() }, destinationContext, requestOptions()) as { temporaryPath: string; directory: string; expectedDestination: string }
      : { temporaryPath: legacyTemporary, directory: legacyTemporary, expectedDestination: "legacy-unverified" };
    if (!stage.temporaryPath || !stage.directory || stage.expectedDestination === undefined) throw new Error("Destination agent does not support private transfer staging");
    const temporaryPath = stage.temporaryPath;
    let offset = 0; let chunks = 0;
    let completedReceipt: CleanupReceipt | undefined;
    let operationError: unknown;
    try {
      signal?.throwIfAborted();
      if (stat.size === 0) await client.fsWrite(input.destinationDevice, { path: temporaryPath, data: "", mode: "rewrite", createParents: true, permissions: 0o600 }, destinationContext, requestOptions());
      signal?.throwIfAborted();
      while (offset < stat.size) {
        signal?.throwIfAborted();
        const length = Math.min(chunk, stat.size - offset);
        const part = await client.fsRead(input.sourceDevice, { path: input.sourcePath, offset, length, encoding: "base64" }, sourceContext, requestOptions()) as ReadResult;
        signal?.throwIfAborted();
        if (part.bytesRead <= 0) throw new Error(`Unexpected EOF at ${offset}/${stat.size}`);
        await client.fsWrite(input.destinationDevice, {
          path: temporaryPath, data: part.data, encoding: "base64",
          mode: offset === 0 ? "rewrite" : "append", createParents: offset === 0, permissions: 0o600,
        }, destinationContext, requestOptions());
        offset += part.bytesRead; chunks += 1;
        signal?.throwIfAborted();
      }
      signal?.throwIfAborted();
      const written = await client.fsManage(input.destinationDevice, { operation: "stat", path: temporaryPath }, destinationContext, requestOptions()) as StatResult;
      if (!written.isFile || written.size !== stat.size) throw new Error(`Transfer verification failed: expected ${stat.size} bytes, got ${written.size}`);
      const sourceAfter = await client.fsManage(input.sourceDevice, { operation: "stat", path: input.sourcePath }, sourceContext, requestOptions()) as StatResult;
      if (sourceAfter.size !== stat.size || sourceAfter.modifiedAt !== stat.modifiedAt || sourceAfter.posixMode !== stat.posixMode) throw new Error("Source changed during transfer");
      if (input.preserveTimestamps && stat.modifiedAt) {
        await client.fsManage(input.destinationDevice, { operation: "times", path: temporaryPath, modifiedAt: stat.modifiedAt }, destinationContext, requestOptions());
      }
      signal?.throwIfAborted();
      const moved = await client.fsManage(input.destinationDevice, modern ? { operation: "transfer-finalize", path: temporaryPath, destination: input.destinationPath, expectedDestination: stage.expectedDestination, expectedBytes: stat.size, sourceMode: stat.posixMode ?? undefined, timeoutMs: deadline.remainingMs() } : { operation: "move", path: temporaryPath, destination: input.destinationPath, force: true }, destinationContext, requestOptions()) as MoveResult;
      if (moved.ok === false) throw new Error(moved.error ?? "Transfer activation failed");
      const destinationAtomic = moved.destinationAtomic ?? moved.atomic ?? false;
      const receipt = { ...publicInput, ...moved, ...(legacy ? { legacyAgent: true, metadataPreserved: false, compatibilityWarning: legacyWarning } : {}), bytes: offset, chunks, transport: "relay-base64", sameFile: false, atomic: destinationAtomic, destinationAtomic, durationMs: Math.round(performance.now() - started) };
      completedReceipt = receipt;
      return receipt;
    } catch (error) { operationError = error; throw error; }
    finally {
      // Best-effort cleanup cannot inherit the normal 120-second request timeout.
      const cleanupDeadline = createDeadline(250);
      let cleanupError: string | undefined;
      try {
        cleanupError = await Promise.race([
          Promise.resolve().then(() => client.fsManage(input.destinationDevice, { operation: "delete", path: stage.directory, force: true, recursive: true }, destinationContext, { timeoutMs: 250, signal: cleanupDeadline.signal }))
            .then(value => (value as { ok?: boolean; error?: string } | undefined)?.ok === false ? ((value as { error?: string }).error ?? "Cleanup operation failed") : undefined, error => error instanceof Error ? error.message : String(error)),
          new Promise<string>(resolve => cleanupDeadline.signal!.addEventListener("abort", () => resolve("Cleanup did not complete within 250ms; completion is unknown"), { once: true })),
        ]);
      } finally { cleanupDeadline.dispose(); }
      if (cleanupError) {
        if (completedReceipt) Object.assign(completedReceipt, { cleanupPending: true, cleanupPath: stage.directory, cleanupError });
        else {
          // DOMException.message and frozen Error objects are not writable.
          // Preserve the original error as cause and retain its classification.
          const message = operationError instanceof Error ? operationError.message : String(operationError);
          const diagnostic = new Error(`${message}; cleanup pending at ${stage.directory}: ${cleanupError}`, { cause: operationError });
          Object.assign(diagnostic, { name: operationError instanceof Error ? operationError.name : "Error",
            cleanupPending: true, cleanupPath: stage.directory, cleanupError });
          throw diagnostic;
        }
      } else if (completedReceipt?.cleanupPath === temporaryPath) {
        delete completedReceipt.cleanupPending; delete completedReceipt.cleanupPath; delete completedReceipt.cleanupError;
      }
    }
  } finally {
    deadline.dispose();
  }
}

export async function syncDirectory(client: AgentClient, input: {
  sourceDevice: string; sourcePath: string; destinationDevice: string; destinationPath: string;
  sourceContext?: AgentContext; destinationContext?: AgentContext;
  chunkBytes?: number; concurrency?: number; maxFiles?: number;
  transport?: "relay" | "direct"; timeoutMs?: number; compare?: "always" | "size-mtime"; allowLegacyAgent?: boolean; signal?: AbortSignal;
}) {
  const started = performance.now();
  const deadline = createDeadline(input.timeoutMs, input.signal, DEFAULT_TRANSFER_TIMEOUT_MS);
  const signal = deadline.signal;
  const requestOptions = () => deadlineOptions(deadline);
  try {
  signal?.throwIfAborted();
  const sourceContext = input.sourceContext ?? "system";
  const destinationContext = input.destinationContext ?? "system";
  const [sourceInfo, destinationInfo] = await Promise.all([client.info(input.sourceDevice, sourceContext, requestOptions()), client.info(input.destinationDevice, destinationContext, requestOptions())]) as [Info, Info];
  signal?.throwIfAborted();
  const srcPath = sourceInfo.platform === "win32" ? path.win32 : path.posix;
  const dstPath = destinationInfo.platform === "win32" ? path.win32 : path.posix;
  const rootStat = await client.fsManage(input.sourceDevice, { operation: "stat", path: input.sourcePath }, sourceContext, requestOptions()) as StatResult;
  signal?.throwIfAborted();
  if (!rootStat.isDirectory) throw new Error(`Source is not a directory: ${input.sourcePath}`);

  const directories: string[] = [""]; const files: Array<{ source: string; relative: string; size: number; modifiedAt?: string }> = []; const skipped: Array<{ path: string; type: string }> = [];
  for (let i = 0; i < directories.length; i += 1) {
    const relative = directories[i]!;
    const current = relative ? srcPath.join(input.sourcePath, relative) : input.sourcePath;
    signal?.throwIfAborted();
    const entries = await client.fsList(input.sourceDevice, { path: current }, sourceContext, requestOptions()) as ListEntry[];
    signal?.throwIfAborted();
    for (const entry of entries) {
      if (entry.error) throw new Error(`Cannot inspect source entry ${entry.path}: ${entry.error}`);
      const rel = relative ? srcPath.join(relative, entry.name) : entry.name;
      if (entry.type === "directory") directories.push(rel);
      else if (entry.type === "file") {
        files.push({ source: entry.path, relative: rel, size: entry.size, ...(entry.modifiedAt ? { modifiedAt: entry.modifiedAt } : {}) });
        if (files.length > (input.maxFiles ?? 10000)) throw new Error(`Directory exceeds maxFiles=${input.maxFiles ?? 10000}`);
      } else skipped.push({ path: entry.path, type: entry.type });
    }
  }

  signal?.throwIfAborted();
  validateDestinationPaths([
    ...directories.slice(1).map((relative) => ({ relative, file: false })),
    ...files.map((file) => ({ relative: file.relative, file: true })),
  ], destinationInfo.platform);
  requireTransferCapability(destinationInfo, input.allowLegacyAgent);
  requireTransferCapability(sourceInfo, input.allowLegacyAgent, "Source");
  await client.fsManage(input.destinationDevice, { operation: "mkdir", path: input.destinationPath, recursive: true }, destinationContext, requestOptions());
  signal?.throwIfAborted();
  for (const relative of directories.slice(1)) {
    signal?.throwIfAborted();
    await client.fsManage(input.destinationDevice, { operation: "mkdir", path: dstPath.join(input.destinationPath, ...destinationSegments(relative, destinationInfo.platform, sourceInfo.platform)), recursive: true }, destinationContext, requestOptions());
    signal?.throwIfAborted();
  }
  const destinationEntries = new Map<string, ListEntry>();
  if (input.compare === "size-mtime") {
    for (const relative of directories) {
      signal?.throwIfAborted();
      const dir = dstPath.join(input.destinationPath, ...destinationSegments(relative, destinationInfo.platform, sourceInfo.platform));
      const entries = await client.fsList(input.destinationDevice, { path: dir }, destinationContext, requestOptions()) as ListEntry[];
      signal?.throwIfAborted();
      for (const entry of entries) destinationEntries.set(dstPath.join(dir, entry.name), entry);
    }
  }
  let bytes = 0;
  const outcomes = await mapLimit(files, input.concurrency ?? 4, async (file) => {
    signal?.throwIfAborted();
    const destination = dstPath.join(input.destinationPath, ...destinationSegments(file.relative, destinationInfo.platform, sourceInfo.platform));
    const existing = destinationEntries.get(destination);
    if (existing && !existing.error && existing.type === "file" && existing.size === file.size &&
        existing.modifiedAt && file.modifiedAt && Math.abs(Date.parse(existing.modifiedAt) - Date.parse(file.modifiedAt)) < 2) {
      return { relative: file.relative, bytes: 0, chunks: 0, unchanged: true };
    }
    const result = await transferFile(client, {
      sourceDevice: input.sourceDevice, sourcePath: file.source, sourceContext, sourceSupportsTransferMetadata: supportsPrivateStage(sourceInfo),
      destinationDevice: input.destinationDevice, destinationPath: destination, destinationContext, destinationPlatform: destinationInfo.platform, destinationSupportsPrivateStage: supportsPrivateStage(destinationInfo), allowLegacyAgent: input.allowLegacyAgent,
      ...(input.chunkBytes === undefined ? {} : { chunkBytes: input.chunkBytes }),
      ...(input.transport === undefined ? {} : { transport: input.transport }),
      ...(deadline.remainingMs() === undefined ? {} : { timeoutMs: deadline.remainingMs() }),
      preserveTimestamps: input.compare === "size-mtime",
      signal,
    });
    bytes += result.bytes; return { relative: file.relative, bytes: result.bytes, chunks: result.chunks, unchanged: false, ...("cleanupPending" in result && result.cleanupPending ? { cleanupPending: true, cleanupPath: result.cleanupPath, cleanupError: result.cleanupError } : {}), ...("legacyAgent" in result && result.legacyAgent ? { legacyAgent: true, metadataPreserved: false, compatibilityWarning: legacyWarning } : {}) };
  });
  const transferred = outcomes.filter((file) => !file.unchanged);
  const unchanged = outcomes.filter((file) => file.unchanged).map((file) => file.relative);
  const pendingCleanup = transferred.filter(file => "cleanupPending" in file && file.cleanupPending);
  return {
    sourceDevice: input.sourceDevice, sourcePath: input.sourcePath, destinationDevice: input.destinationDevice, destinationPath: input.destinationPath,
    directories: directories.length, files: files.length, bytes, skipped, transferred, unchanged, filesTransferred: transferred.length, filesUnchanged: unchanged.length, compare: input.compare ?? "always",
    ...(pendingCleanup.length ? { cleanupPending: true, cleanupPendingCount: pendingCleanup.length, cleanupPaths: pendingCleanup.map(file => "cleanupPath" in file ? file.cleanupPath : undefined).filter(value => typeof value === "string") } : {}),
    ...((!supportsPrivateStage(destinationInfo) || !supportsPrivateStage(sourceInfo)) ? { legacyAgent: true, metadataPreserved: false, compatibilityWarning: legacyWarning } : {}),
    durationMs: Math.round(performance.now() - started), note: "Copies/updates files; existing destination-only files are preserved.",
  };
  } finally {
    deadline.dispose();
  }
}

export function registerTransferTools(server: McpServer, client: AgentClient): void {
  server.registerTool("file_transfer", {
    description: "Copy a file via bounded MCP relay or opt-in direct binary agent transfer. Direct mode requires the source endpoint to be reachable from the destination agent.",
    inputSchema: {
      sourceDevice: z.string().min(1), sourcePath: z.string().min(1), sourceContext: z.enum(["system", "user"]).optional(),
      destinationDevice: z.string().min(1), destinationPath: z.string().min(1), destinationContext: z.enum(["system", "user"]).optional(),
      transport: z.enum(["relay", "direct"]).optional(),
      allowLegacyAgent: z.boolean().optional().describe("Explicitly allow older source or destination agents without private metadata transfer support. Default false; legacy mode does not guarantee permissions/ACL/executable preservation. Modern agents always use the preserving protocol."),
      timeoutMs: timeoutMsField.optional(),
      chunkBytes: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).optional(),
      preserveTimestamps: z.boolean().optional(),
    },
  }, async (input, extra) => text(await transferFile(client, { ...input, signal: extra.signal })));

  server.registerTool("directory_sync", {
    description: "Recursively copy/update a directory tree between any two configured computers, including Linux↔Windows. Destination-only files are preserved. Opt-in size-mtime comparison skips unchanged files (2 ms timestamp tolerance; not a content hash).",
    inputSchema: {
      sourceDevice: z.string().min(1), sourcePath: z.string().min(1), sourceContext: z.enum(["system", "user"]).optional(),
      destinationDevice: z.string().min(1), destinationPath: z.string().min(1), destinationContext: z.enum(["system", "user"]).optional(),
      transport: z.enum(["relay", "direct"]).optional(),
      allowLegacyAgent: z.boolean().optional().describe("Explicitly allow older source or destination agents without private metadata transfer support. Default false; legacy mode does not guarantee permissions/ACL/executable preservation. Modern agents always use the preserving protocol."),
      timeoutMs: timeoutMsField.optional(),
      compare: z.enum(["always", "size-mtime"]).optional(),
      chunkBytes: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).optional(), concurrency: z.number().int().min(1).max(16).optional(), maxFiles: z.number().int().min(1).max(100000).optional(),
    },
  }, async (input, extra) => text(await syncDirectory(client, { ...input, signal: extra.signal })));
}
