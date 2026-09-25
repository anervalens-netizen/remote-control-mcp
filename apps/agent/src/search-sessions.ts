import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import type { SearchInput } from "./search.ts";
import { buildSearchArgs, createFileMatcher, normalizeFileResult, parseRgMatchLine, validatePersistentSearchPattern } from "./search-common.ts";
import { currentProcessIdentityAsync, processAlive, terminateVerifiedProcess, terminateVerifiedProcessTreeDetailedAsync } from "./process-identity.ts";
import { runtimeInstanceId } from "./runtime.ts";
import { atomicWriteJson, ensureStateDir } from "./state.ts";

const rgPath = process.env.RCMCP_RG_PATH ?? "rg";
type Status = "running" | "done" | "stopped" | "error" | "lost";
type SearchMeta = {
  id: string;
  input: SearchInput;
  status: Status;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  resultsPath: string;
  stderrPath: string;
  resultsCount: number;
  limited: boolean;
  error?: string;
  root: string;
  resultBase?: string;
  pid: number | null;
  processIdentity?: string;
  exitCode: number | null;
  ownerInstanceId: string;
  recoveryReason?: string;
};
type Session = {
  meta: SearchMeta;
  child: ChildProcess;
  identityReady: Promise<void>;
  pending: string;
  stderrTail: string;
  matcher?: (value: string) => boolean;
  stdoutEnded: boolean;
  childClosed: boolean;
  metadataPublished: boolean;
  startupFailed: boolean;
};

const searchRoot = ensureStateDir("search");
const sessions = new Map<string, Session>();

function metaPath(id: string): string { return path.join(searchRoot, `${id}.json`); }
function resultsPath(id: string): string { return path.join(searchRoot, `${id}.results.jsonl`); }
function stderrPath(id: string): string { return path.join(searchRoot, `${id}.stderr.log`); }
function readMeta(id: string): SearchMeta {
  const file = metaPath(id);
  if (!existsSync(file)) throw new Error(`Unknown search session: ${id}`);
  return JSON.parse(readFileSync(file, "utf8")) as SearchMeta;
}
function writeMeta(meta: SearchMeta): void {
  meta.updatedAt = new Date().toISOString();
  atomicWriteJson(metaPath(meta.id), meta);
}

function syncRegularFile(file: string): void {
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function countJsonl(file: string): number {
  if (!existsSync(file)) return 0;
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  let total = 0;
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 0x0a) total += 1;
      offset += bytesRead;
    }
  } finally { closeSync(fd); }
  return total;
}

function readJsonlPage(file: string, offset: number, length: number): unknown[] {
  if (!existsSync(file) || length <= 0) return [];
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder("utf8");
  const results: unknown[] = [];
  let pending = "";
  let byteOffset = 0;
  let index = 0;
  const consume = (text: string) => {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (index >= offset && results.length < length && line) results.push(JSON.parse(line));
      index += 1;
    }
  };
  try {
    while (results.length < length) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, byteOffset);
      if (bytesRead === 0) break;
      byteOffset += bytesRead;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    const tail = decoder.end();
    if (tail) consume(tail);
    if (pending && results.length < length && index >= offset) {
      try { results.push(JSON.parse(pending)); }
      catch (error) {
        // Results are appended as newline-terminated JSON. A crash can leave only
        // the final record torn; preserve all complete durable records and ignore
        // that incomplete tail rather than making historical reads unusable.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  } finally { closeSync(fd); }
  return results;
}

function readJsonlCursorPage(
  file: string,
  cursor: number,
  length: number,
  includeTail: boolean,
  maxBytes: number,
): { results: unknown[]; nextCursor: number; eof: boolean; budgetLimited: boolean; pageBytes: number; requiredBytes: number | null } {
  const safeCursor = Math.max(0, cursor);
  if (!existsSync(file) || length <= 0) {
    return { results: [], nextCursor: safeCursor, eof: true, budgetLimited: false, pageBytes: 0, requiredBytes: null };
  }
  const size = statSync(file).size;
  const start = Math.min(safeCursor, size);
  const fd = openSync(file, "r");
  const readBuffer = Buffer.alloc(64 * 1024);
  const results: unknown[] = [];
  let readOffset = start;
  let pending = Buffer.alloc(0);
  let pendingStart = start;
  let nextCursor = start;
  let reachedEof = false;
  let budgetLimited = false;
  let pageBytes = 0;
  try {
    while (results.length < length) {
      const bytesRead = readSync(fd, readBuffer, 0, readBuffer.length, readOffset);
      if (bytesRead === 0) { reachedEof = true; break; }
      const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
      const combined = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const combinedStart = pendingStart;
      let lineStart = 0;
      while (results.length < length) {
        const newline = combined.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const line = combined.subarray(lineStart, newline);
        const lineEndCursor = combinedStart + newline + 1;
        if (line.length) {
          const lineBytes = line.length + 1;
          if (pageBytes + lineBytes > maxBytes) {
            budgetLimited = true;
            return { results, nextCursor, eof: false, budgetLimited, pageBytes, requiredBytes: lineBytes };
          }
          results.push(JSON.parse(line.toString("utf8")));
          pageBytes += lineBytes;
        }
        nextCursor = lineEndCursor;
        lineStart = newline + 1;
      }
      if (results.length >= length) {
        return { results, nextCursor, eof: nextCursor >= size, budgetLimited, pageBytes, requiredBytes: null };
      }
      pending = combined.subarray(lineStart);
      pendingStart = combinedStart + lineStart;
      readOffset += bytesRead;
    }
    if (reachedEof && pending.length && includeTail && results.length < length) {
      if (pageBytes + pending.length > maxBytes) {
        budgetLimited = true;
        return { results, nextCursor, eof: false, budgetLimited, pageBytes, requiredBytes: pending.length };
      }
      try {
        results.push(JSON.parse(pending.toString("utf8")));
        pageBytes += pending.length;
      }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      // Terminal sessions deliberately skip a torn final record rather than
      // forcing every future cursor read to reparse the same crash tail.
      nextCursor = size;
    } else if (reachedEof && pending.length === 0) {
      nextCursor = size;
    }
    return { results, nextCursor, eof: reachedEof && nextCursor >= size, budgetLimited, pageBytes, requiredBytes: null };
  } finally { closeSync(fd); }
}

function recoverPersisted(): void {
  for (const name of readdirSync(searchRoot)) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = readMeta(name.slice(0, -5));
      const durableResultsCount = countJsonl(meta.resultsPath);
      if (meta.status === "running") {
        const orphanStopped = process.platform !== "win32" && meta.pid !== null && meta.processIdentity
          ? terminateVerifiedProcess(meta.pid, meta.processIdentity, meta.createdAt)
          : false;
        if (process.platform === "win32" && meta.pid !== null && meta.processIdentity) {
          void terminateVerifiedProcessTreeDetailedAsync(meta.pid, meta.processIdentity, meta.createdAt, 1000, "SIGTERM", "RCMCP_SEARCH_SESSION_ID=" + meta.id).catch(() => undefined);
        }
        meta.status = "lost";
        meta.finishedAt = new Date().toISOString();
        meta.resultsCount = durableResultsCount;
        meta.recoveryReason = process.platform === "win32"
          ? "agent_restarted_search_termination_unverified"
          : orphanStopped
          ? "agent_restarted_search_orphan_stopped"
          : "agent_restarted_search_not_reattachable";
        meta.error ??= orphanStopped
          ? "Search process was stopped during agent restart recovery"
          : "Search process was interrupted by agent restart";
        writeMeta(meta);
      } else if (meta.resultsCount !== durableResultsCount) {
        meta.resultsCount = durableResultsCount;
        writeMeta(meta);
      }
    } catch { /* preserve unreadable state for manual recovery */ }
  }
}
recoverPersisted();

function pushResult(session: Session, result: unknown): void {
  if (session.meta.status !== "running") return;
  const limit = session.meta.input.maxResults ?? 10_000;
  if (session.meta.resultsCount >= limit) return;
  appendFileSync(session.meta.resultsPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  session.meta.resultsCount += 1;
  if (session.meta.resultsCount >= limit) {
    session.meta.limited = true;
    writeMeta(session.meta);
    session.child.kill("SIGTERM");
  }
}

function failSession(session: Session, error: unknown): void {
  if (session.meta.status !== "error") {
    session.meta.status = "error";
    session.meta.error = error instanceof Error ? error.message : String(error);
    session.meta.finishedAt = new Date().toISOString();
    try { writeMeta(session.meta); }
    catch (persistError) {
      session.meta.error += `; metadata persistence failed: ${persistError instanceof Error ? persistError.message : String(persistError)}`;
    }
  }
  try { session.child.kill("SIGTERM"); } catch { /* already exited */ }
}

async function cleanupFailedSearchStart(session: Session, reason: string, probeIdentity: boolean): Promise<void> {
  session.startupFailed = true;
  session.meta.status = "lost";
  session.meta.finishedAt ??= new Date().toISOString();
  session.meta.recoveryReason = reason;
  let terminated = false;
  try {
    const identity = session.meta.processIdentity ?? (probeIdentity && session.meta.pid !== null ? await currentProcessIdentityAsync(session.meta.pid) : null);
    if (identity && session.meta.pid !== null) {
      session.meta.processIdentity = identity;
      if (process.platform === "win32") {
        const result = await terminateVerifiedProcessTreeDetailedAsync(
          session.meta.pid,
          identity,
          session.meta.createdAt,
          1000,
          "SIGTERM",
          "RCMCP_SEARCH_SESSION_ID=" + session.meta.id,
        );
        terminated = result.terminated || !processAlive(session.meta.pid);
      } else if (probeIdentity) {
        terminated = terminateVerifiedProcess(session.meta.pid, identity, session.meta.createdAt);
      }
    }
  } catch { /* fall through to the child handle */ }
  if (!terminated) {
    try { session.child.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* process may already be gone */ }
  }
  const deadline = Date.now() + (process.platform === "win32" ? 2500 : 500);
  while (!session.childClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  sessions.delete(session.meta.id);
  const persisted = session.metadataPublished && existsSync(metaPath(session.meta.id)) ? (() => {
    try { writeMeta(session.meta); return true; }
    catch { return false; }
  })() : false;
  if (!persisted) {
    for (const file of [metaPath(session.meta.id), session.meta.resultsPath, session.meta.stderrPath]) rmSync(file, { force: true });
  }
}

const MAX_PENDING_JSON_CHARS = 4 * 1024 * 1024;

function parseLine(session: Session, line: string): void {
  if (!line || session.meta.status !== "running") return;
  if (line.length > MAX_PENDING_JSON_CHARS) {
    failSession(session, new Error(
      `ripgrep emitted a result line larger than ${MAX_PENDING_JSON_CHARS} characters; use a narrower search or read the file directly`,
    ));
    return;
  }
  try {
    const resultBase = session.meta.resultBase ?? session.meta.root;
    if (session.meta.input.mode === "files") {
      if (session.matcher?.(line)) pushResult(session, { path: normalizeFileResult(resultBase, line) });
      return;
    }
    const result = parseRgMatchLine(line, resultBase);
    if (result) pushResult(session, result);
  } catch (error) { failSession(session, error); }
}

export async function searchStart(input: SearchInput) {
  validatePersistentSearchPattern(input, rgPath);
  const matcher = input.mode === "files" ? createFileMatcher(input) : undefined;
  const { args, root, cwd, resultBase } = buildSearchArgs(input);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const resultFile = resultsPath(id);
  const errorFile = stderrPath(id);
  writeFileSync(resultFile, "", { mode: 0o600 });
  writeFileSync(errorFile, "", { mode: 0o600 });
  const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  const meta: SearchMeta = {
    id, input, status: "running", createdAt, updatedAt: createdAt,
    resultsPath: resultFile, stderrPath: errorFile, resultsCount: 0, limited: false, root, resultBase,
    pid: child.pid ?? null,
    processIdentity: undefined,
    exitCode: null, ownerInstanceId: runtimeInstanceId,
  };
  let resolveLifecycle!: () => void;
  const lifecycle = new Promise<void>((resolve) => { resolveLifecycle = resolve; });
  const session: Session = {
    meta, child, identityReady: Promise.resolve(), pending: "", stderrTail: "", stdoutEnded: false, childClosed: false,
    ...(matcher ? { matcher } : {}), metadataPublished: false, startupFailed: false,
  };

  child.stdout!.on("data", (chunk: string) => {
    if (session.meta.status !== "running") return;
    let cursor = 0;
    while (cursor < chunk.length && session.meta.status === "running") {
      const newline = chunk.indexOf("\n", cursor);
      if (newline < 0) {
        const tail = chunk.slice(cursor);
        if (session.pending.length + tail.length > MAX_PENDING_JSON_CHARS) {
          failSession(session, new Error(
            "ripgrep emitted an unterminated result larger than " + MAX_PENDING_JSON_CHARS + " characters; use a narrower search or read the file directly",
          ));
          return;
        }
        session.pending += tail;
        return;
      }
      const piece = chunk.slice(cursor, newline);
      if (session.pending.length + piece.length > MAX_PENDING_JSON_CHARS) {
        failSession(session, new Error(
          "ripgrep emitted a result line larger than " + MAX_PENDING_JSON_CHARS + " characters; use a narrower search or read the file directly",
        ));
        return;
      }
      const line = session.pending + piece;
      session.pending = "";
      parseLine(session, line);
      cursor = newline + 1;
    }
  });
  child.stderr!.on("data", (chunk: string) => {
    if (session.meta.status !== "running") return;
    try {
      appendFileSync(errorFile, chunk, { encoding: "utf8", mode: 0o600 });
      session.stderrTail = `${session.stderrTail}${chunk}`.slice(-64 * 1024);
    } catch (error) {
      failSession(session, new Error(`Search stderr persistence failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  child.stdout!.once("end", () => { session.stdoutEnded = true; finalize(); });
  child.once("error", (error) => { failSession(session, error); session.childClosed = true; finalize(); });
  child.once("close", (code) => { session.childClosed = true; session.meta.exitCode = code; finalize(); });

  try {
    writeMeta(meta);
    session.metadataPublished = true;
  } catch (error) {
    await cleanupFailedSearchStart(session, "search_metadata_registration_failed", true);
    throw error;
  }
  sessions.set(id, session);
  session.identityReady = (async () => {
    if (child.pid === undefined) throw new Error(`Search session ${id} did not expose a process id`);
    const identity = await currentProcessIdentityAsync(child.pid);
    if (!existsSync(metaPath(id))) throw new Error(`Search session ${id} was removed during startup`);
    if (!identity) {
      if (session.meta.status !== "running") return;
      await Promise.race([lifecycle, new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref();
      })]);
      if (session.meta.status !== "running") return;
      throw new Error(`Search session ${id} process identity could not be established while running`);
    }
    session.meta.processIdentity = identity;
    try { writeMeta(session.meta); }
    catch (error) { throw new Error(`Search session ${id} process identity persistence failed: ${error instanceof Error ? error.message : String(error)}`); }
  })();

  try {
    await session.identityReady;
  } catch (error) {
    await cleanupFailedSearchStart(session, error instanceof Error && error.message.includes("persistence") ? "search_process_identity_persistence_failed" : "search_process_identity_unavailable", false);
    throw error;
  }
  return { id, status: session.meta.status, createdAt };

  function finalize() {
    if (!session.stdoutEnded || !session.childClosed) return;
    if (session.startupFailed) {
      sessions.delete(id);
      resolveLifecycle();
      return;
    }
    if (session.pending && session.meta.status === "running") {
      const pending = session.pending;
      session.pending = "";
      parseLine(session, pending);
    }
    if (session.meta.status === "running") {
      session.meta.status = session.meta.exitCode === 0 || session.meta.exitCode === 1 || session.meta.limited ? "done" : "error";
    }
    if (session.meta.status === "error" && !session.meta.error) {
      session.meta.error = session.stderrTail.trim() || `rg exited ${session.meta.exitCode}`;
    }
    session.meta.finishedAt ??= new Date().toISOString();
    try {
      syncRegularFile(session.meta.resultsPath);
      syncRegularFile(session.meta.stderrPath);
    } catch (error) {
      session.meta.status = "error";
      session.meta.error ??= `Search durability sync failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    try { writeMeta(session.meta); }
    catch (error) {
      session.meta.status = "error";
      session.meta.error = `Search terminal metadata persistence failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    sessions.delete(id);
    resolveLifecycle();
  }
}

const DEFAULT_SEARCH_PAGE_BYTES = 60 * 1024;
const MAX_SEARCH_PAGE_BYTES = 16 * 1024 * 1024;

function trimPageByBytes(results: unknown[], maxBytes: number) {
  const selected: unknown[] = [];
  let pageBytes = 0;
  for (const result of results) {
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8") + 1;
    if (pageBytes + bytes > maxBytes) {
      return { results: selected, pageBytes, budgetLimited: true, requiredBytes: bytes };
    }
    selected.push(result);
    pageBytes += bytes;
  }
  return { results: selected, pageBytes, budgetLimited: false, requiredBytes: null as number | null };
}

export function searchResults(id: string, offset = 0, length = 100, cursor?: number, maxBytes = DEFAULT_SEARCH_PAGE_BYTES) {
  const session = sessions.get(id);
  const meta = session?.meta ?? readMeta(id);
  const safeOffset = Math.max(0, offset);
  const safeLength = Math.max(1, Math.min(length, 1000));
  const safeCursor = cursor === undefined ? undefined : Math.max(0, cursor);
  const safeMaxBytes = Math.max(1024, Math.min(maxBytes, MAX_SEARCH_PAGE_BYTES));
  const cursorPage = safeCursor === undefined
    ? null
    : readJsonlCursorPage(meta.resultsPath, safeCursor, safeLength, meta.status !== "running", safeMaxBytes);
  const offsetPage = cursorPage
    ? null
    : trimPageByBytes(readJsonlPage(meta.resultsPath, safeOffset, safeLength), safeMaxBytes);
  const results = cursorPage?.results ?? offsetPage!.results;
  const pageLimited = cursorPage?.budgetLimited ?? offsetPage!.budgetLimited;
  const pageBytes = cursorPage?.pageBytes ?? offsetPage!.pageBytes;
  const requiredBytes = cursorPage !== null ? cursorPage.requiredBytes : offsetPage!.requiredBytes;
  return {
    id, status: meta.status, offset: safeOffset, nextOffset: safeOffset + results.length,
    cursor: safeCursor ?? null, nextCursor: cursorPage?.nextCursor ?? null, eof: cursorPage?.eof ?? null,
    available: meta.resultsCount, results, limited: meta.limited, pageLimited, pageBytes, maxBytes: safeMaxBytes,
    requiredBytes,
    error: meta.error ?? null, recoveryReason: meta.recoveryReason ?? null,
  };
}

export function searchStop(id: string) {
  const session = sessions.get(id);
  const meta = session?.meta ?? readMeta(id);
  if (session && meta.status === "running") {
    meta.status = "stopped";
    meta.finishedAt = new Date().toISOString();
    writeMeta(meta);
    session.child.kill("SIGTERM");
  }
  return { id, status: meta.status, available: meta.resultsCount };
}

export function searchSessions() {
  return readdirSync(searchRoot).filter((name) => name.endsWith(".json")).map((name) => {
    const id = name.slice(0, -5);
    const meta = sessions.get(id)?.meta ?? readMeta(id);
    return {
      id, status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      available: meta.resultsCount, limited: meta.limited, error: meta.error ?? null,
      recoveryReason: meta.recoveryReason ?? null,
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function waitClosed(session: Session, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.childClosed) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return session.childClosed;
}

export async function searchRemove(id: string, force = false) {
  const session = sessions.get(id);
  const meta = session?.meta ?? readMeta(id);
  if (session && meta.status === "running") {
    if (!force) throw new Error("Search session is still running; stop it or use force=true");
    searchStop(id);
  }
  if (session && !session.childClosed) {
    if (!(await waitClosed(session, 500))) {
      try { session.child.kill("SIGKILL"); } catch { /* already exited */ }
      if (!(await waitClosed(session, 1000))) throw new Error(`Search session ${id} did not stop for removal`);
    }
  }
  sessions.delete(id);
  for (const file of [metaPath(id), meta.resultsPath, meta.stderrPath]) rmSync(file, { force: true });
  return { id, removed: true };
}
