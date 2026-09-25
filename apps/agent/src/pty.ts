import { closeVerifiedWindowsPty } from "./conpty-cleanup.ts";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import * as pty from "node-pty";
import { processAlive, currentProcessIdentityAsync, terminateVerifiedProcessTree, terminateVerifiedProcessTreeDetailedAsync } from "./process-identity.ts";
import { runtimeStringEnv } from "./runtime-env.ts";
import { runtimeInstanceId } from "./runtime.ts";
import { atomicWriteJson, ensureStateDir, utf8LeadingCodePointLength, utf8SafeLength } from "./state.ts";
import { attachWindowsProcessTracker, releaseWindowsProcessTracker } from "./windows-process-tracker.ts";

type PtyState = "running" | "exited" | "lost";
type PtyMeta = {
  id: string;
  pid: number;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  state: PtyState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: number;
  outputPath: string;
  processIdentity?: string;
  ownerInstanceId: string;
  recoveryReason?: string;
  terminationVerified?: boolean;
  terminationVerification?: string | null;
  terminationVerificationScope?: string | null;
  terminationReason?: string | null;
};
type Session = { terminal: pty.IPty; meta: PtyMeta; identityReady: Promise<void> };

const ptyRoot = ensureStateDir("pty");
const sessions = new Map<string, Session>();
const volatileMeta = new Map<string, PtyMeta>();

function metaPath(id: string): string { return path.join(ptyRoot, `${id}.json`); }
function outputPath(id: string): string { return path.join(ptyRoot, `${id}.out.log`); }
function readMeta(id: string): PtyMeta {
  const fallback = volatileMeta.get(id);
  if (fallback) return { ...fallback };
  const file = metaPath(id);
  if (!existsSync(file)) throw new Error("Unknown PTY session: " + id);
  return JSON.parse(readFileSync(file, "utf8")) as PtyMeta;
}

function writeMeta(meta: PtyMeta): void {
  meta.updatedAt = new Date().toISOString();
  atomicWriteJson(metaPath(meta.id), meta);
  volatileMeta.delete(meta.id);
}

function writeMetaRecoverably(meta: PtyMeta, failureReason: string): boolean {
  try {
    writeMeta(meta);
    return true;
  } catch {
    meta.state = "lost";
    meta.recoveryReason ??= failureReason;
    meta.updatedAt = new Date().toISOString();
    volatileMeta.set(meta.id, { ...meta });
    return false;
  }
}

function syncOutputForTerminalState(output: string): void {
  if (!existsSync(output)) return;
  const fd = openSync(output, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function recoverPersisted(): void {
  for (const name of readdirSync(ptyRoot)) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = readMeta(name.slice(0, -5));
      if (meta.state === "running") {
        const survivorStopped = process.platform !== "win32" && meta.processIdentity
          ? terminateVerifiedProcessTree(meta.pid, meta.processIdentity, meta.createdAt, 1000, "SIGTERM", "RCMCP_PTY_SESSION_ID=" + meta.id)
          : false;
        if (process.platform === "win32" && meta.processIdentity) {
          void terminateVerifiedProcessTreeDetailedAsync(meta.pid, meta.processIdentity, meta.createdAt, 1000, "SIGTERM", "RCMCP_PTY_SESSION_ID=" + meta.id);
        }
        meta.state = "lost";
        meta.finishedAt = new Date().toISOString();
        meta.recoveryReason = process.platform === "win32"
          ? "agent_restarted_session_termination_unverified"
          : survivorStopped
          ? "agent_restarted_session_survivor_stopped"
          : "agent_restarted_session_not_reattachable";
        writeMeta(meta);
      }
    } catch { /* preserve unreadable state for manual recovery */ }
  }
}
recoverPersisted();

function getLive(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    const meta = readMeta(id);
    throw new Error(`PTY session ${id} is not attached to this agent instance (state=${meta.state})`);
  }
  return session;
}

function resolveWindowsShell(requested?: string): string {
  const shell = requested ?? "powershell.exe";
  if (path.win32.isAbsolute(shell)) return shell;
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const lower = shell.toLowerCase();
  if (lower === "powershell" || lower === "powershell.exe") {
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  }
  if (lower === "cmd" || lower === "cmd.exe") return path.win32.join(root, "System32", "cmd.exe");
  // node-pty/CreateProcess resolves non-system shells through PATH. Calling
  // where.exe synchronously here used to block the request thread on Windows.
  return shell;
}

async function stopUnpublishedPty(terminal: pty.IPty, pid: number, createdAt: string, id: string): Promise<void> {
  if (process.platform !== "win32") {
    try { terminal.kill("SIGKILL"); } catch { /* process may already be gone */ }
    return;
  }
  try {
    const identity = await currentProcessIdentityAsync(pid);
    if (identity) {
      const result = await terminateVerifiedProcessTreeDetailedAsync(pid, identity, createdAt, 1000, "SIGTERM", "RCMCP_PTY_SESSION_ID=" + id);
      if (result.terminated || !processAlive(pid)) {
        closeVerifiedWindowsPty(terminal);
        return;
      }
    }
  } catch { /* fall through to the native PTY close */ }
  try { terminal.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* process may already be gone */ }
}

async function cleanupFailedPtyStart(session: Session, reason: string, published: boolean): Promise<void> {
  session.meta.state = "lost";
  session.meta.finishedAt ??= new Date().toISOString();
  session.meta.recoveryReason = reason;
  try {
    if (process.platform === "win32" && session.meta.processIdentity) {
      const result = await terminateVerifiedProcessTreeDetailedAsync(
        session.meta.pid,
        session.meta.processIdentity,
        session.meta.createdAt,
        1000,
        "SIGTERM",
        "RCMCP_PTY_SESSION_ID=" + session.meta.id,
      );
      if (!processAlive(session.meta.pid)) {
        closeVerifiedWindowsPty(session.terminal);
      } else if (!result.terminated) {
        try { session.terminal.kill(); } catch { /* process may already be gone */ }
      }
    } else {
      try { session.terminal.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* process may already be gone */ }
    }
  } catch {
    try { session.terminal.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* process may already be gone */ }
  }
  await waitForExit(session, process.platform === "win32" ? 2500 : 500);
  sessions.delete(session.meta.id);
  const persisted = published && existsSync(metaPath(session.meta.id)) ? writeMetaRecoverably(session.meta, reason) : false;
  if (!persisted) {
    rmSync(metaPath(session.meta.id), { force: true });
    rmSync(session.meta.outputPath, { force: true });
    volatileMeta.delete(session.meta.id);
  }
}

export async function ptyStart(input: { shell?: string; cwd?: string; cols?: number; rows?: number; env?: Record<string, string> }) {
  const shell = process.platform === "win32" ? resolveWindowsShell(input.shell) : input.shell ?? process.env.SHELL ?? "/bin/bash";
  const cwd = input.cwd ?? os.homedir();
  const args = process.platform === "win32" && /powershell/i.test(shell) ? ["-NoLogo"] : [];
  const id = randomUUID();
  const terminal = pty.spawn(shell, args, {
    name: "xterm-256color", cols: input.cols ?? 120, rows: input.rows ?? 40,
    cwd, env: runtimeStringEnv({ ...(input.env ?? {}), RCMCP_PTY_SESSION_ID: id }),
  });
  const createdAt = new Date().toISOString();
  const meta: PtyMeta = {
    id, pid: terminal.pid, shell, cwd, cols: terminal.cols, rows: terminal.rows,
    state: "running", createdAt, updatedAt: createdAt, outputPath: outputPath(id),
    ownerInstanceId: runtimeInstanceId,
  };
  let published = false;
  let resolveExit!: () => void;
  const exitObserved = new Promise<void>((resolve) => { resolveExit = resolve; });
  const session = { terminal, meta, identityReady: Promise.resolve() } as Session;

  terminal.onData((data) => {
    if (session.meta.state !== "running") return;
    try {
      appendFileSync(meta.outputPath, data, { encoding: "utf8", mode: 0o600 });
    } catch {
      session.meta.state = "lost";
      session.meta.finishedAt ??= new Date().toISOString();
      session.meta.recoveryReason = "pty_output_persistence_failed";
      writeMetaRecoverably(session.meta, "pty_terminal_metadata_persistence_failed");
      try {
        if (session.meta.processIdentity) {
          void terminateVerifiedProcessTreeDetailedAsync(session.meta.pid, session.meta.processIdentity, session.meta.createdAt, 1000, "SIGTERM", "RCMCP_PTY_SESSION_ID=" + session.meta.id).catch(() => undefined);
        } else {
          session.terminal.kill(process.platform === "win32" ? undefined : "SIGKILL");
        }
      } catch {
        try { session.terminal.kill(process.platform === "win32" ? undefined : "SIGKILL"); }
        catch { /* process may already be gone */ }
      }
    }
  });
  terminal.onExit(({ exitCode, signal }) => {
    const persistenceAlreadyLost = session.meta.state === "lost";
    session.meta.exitCode = exitCode;
    session.meta.signal = signal;
    session.meta.finishedAt = new Date().toISOString();
    sessions.delete(id);
    void releaseWindowsProcessTracker(session.meta.pid, session.meta.processIdentity).catch(() => undefined);
    if (published && (!existsSync(metaPath(id)) && !volatileMeta.has(id))) {
      resolveExit();
      return;
    }
    if (!persistenceAlreadyLost) {
      try {
        syncOutputForTerminalState(session.meta.outputPath);
        session.meta.state = "exited";
      } catch {
        session.meta.state = "lost";
        session.meta.recoveryReason = "pty_output_sync_failed_before_exit_publish";
      }
    }
    if (published) writeMetaRecoverably(session.meta, "pty_terminal_metadata_persistence_failed");
    resolveExit();
  });

  try {
    writeFileSync(meta.outputPath, "", { mode: 0o600 });
    writeMeta(meta);
    published = true;
  } catch (error) {
    await stopUnpublishedPty(terminal, terminal.pid, meta.createdAt, id);
    sessions.delete(id);
    rmSync(metaPath(id), { force: true });
    rmSync(meta.outputPath, { force: true });
    throw error;
  }

  session.identityReady = (async () => {
    const identity = await currentProcessIdentityAsync(terminal.pid);
    if (!existsSync(metaPath(id))) throw new Error(`PTY session ${id} was removed during startup`);
    if (!identity) {
      if (meta.state !== "running") return;
      await Promise.race([exitObserved, new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref();
      })]);
      if (meta.state !== "running") return;
      throw new Error(`PTY session ${id} process identity could not be established while running`);
    }
    meta.processIdentity = identity;
    try { writeMeta(meta); }
    catch (error) { throw new Error(`PTY session ${id} process identity persistence failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (process.platform === "win32" && meta.state === "running") {
      void attachWindowsProcessTracker(terminal.pid, identity).catch(() => undefined);
    }
  })();
  sessions.set(id, session);

  try {
    await session.identityReady;
  } catch (error) {
    await cleanupFailedPtyStart(session, error instanceof Error && error.message.includes("persistence") ? "pty_process_identity_persistence_failed" : "pty_process_identity_unavailable", published);
    throw error;
  }
  return { id, pid: terminal.pid, shell, cwd, cols: terminal.cols, rows: terminal.rows, state: meta.state };
}

export function ptyInput(id: string, data: string) {
  const session = getLive(id);
  if (session.meta.state !== "running") throw new Error(`PTY session ${id} is ${session.meta.state}`);
  session.terminal.write(data);
  return { ok: true, id, bytes: Buffer.byteLength(data) };
}

export function ptyOutput(id: string, offset = 0, length?: number) {
  const meta = readMeta(id);
  const totalBytes = existsSync(meta.outputPath) ? statSync(meta.outputPath).size : 0;
  const start = Math.min(Math.max(offset, 0), totalBytes);
  const requested = Math.min(length ?? 64 * 1024, 1024 * 1024, totalBytes - start);
  const buffer = Buffer.alloc(Math.max(requested, length === undefined ? 0 : 4));
  let rawBytesRead = 0;
  if (requested > 0) {
    const fd = openSync(meta.outputPath, "r");
    try {
      rawBytesRead = readSync(fd, buffer, 0, requested, start);
      if (length !== undefined && rawBytesRead > 0 && start + rawBytesRead < totalBytes) {
        const safe = utf8SafeLength(buffer.subarray(0, rawBytesRead));
        if (safe === 0) {
          const expected = utf8LeadingCodePointLength(buffer.subarray(0, rawBytesRead));
          const extra = Math.min(Math.max(expected - rawBytesRead, 0), totalBytes - start - rawBytesRead);
          if (extra > 0) rawBytesRead += readSync(fd, buffer, rawBytesRead, extra, start + rawBytesRead);
        }
      }
    } finally { closeSync(fd); }
  }
  let bytesRead = rawBytesRead;
  if (start + rawBytesRead < totalBytes && rawBytesRead > 0) bytesRead = utf8SafeLength(buffer.subarray(0, rawBytesRead));
  const data = buffer.subarray(0, bytesRead);
  const nextOffset = start + bytesRead;
  return {
    id, state: meta.state, offset: start, nextOffset, totalBytes, bytesRead, eof: nextOffset >= totalBytes,
    data: data.toString("utf8"), exited: meta.state === "exited", terminationVerified: meta.state === "exited" && meta.terminationVerified === true,
    exitCode: meta.exitCode ?? null, signal: meta.signal ?? null, recoveryReason: meta.recoveryReason ?? null,
  };
}

export function ptyResize(id: string, cols: number, rows: number) {
  const session = getLive(id);
  session.terminal.resize(cols, rows);
  session.meta.cols = cols;
  session.meta.rows = rows;
  writeMeta(session.meta);
  return { ok: true, id, cols, rows };
}

async function waitForExit(session: Session, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.meta.state !== "running") return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return session.meta.state !== "running";
}

export async function ptyTerminate(id: string, signal?: string) {
  const historical = readMeta(id);
  const session = sessions.get(id);
  if (!session) {
    if (historical.state === "lost") {
      return {
        ok: true, id, state: historical.state, signal: historical.signal ?? null,
        exited: false, alreadyExited: false, terminationVerified: false, forced: false,
        exitCode: historical.exitCode ?? null, recoveryReason: historical.recoveryReason ?? null,
      };
    }
    return {
      ok: true, id, state: historical.state, signal: historical.signal ?? null,
      exited: true, alreadyExited: true, terminationVerified: historical.terminationVerified === true, forced: false,
      terminationVerification: historical.terminationVerification ?? null,
      terminationVerificationScope: historical.terminationVerificationScope ?? "unverified",
      terminationReason: historical.terminationReason ?? "terminal_exit_observed_tree_not_verified",
      exitCode: historical.exitCode ?? null,
    };
  }
  if (session.meta.state !== "running") {
    return { ok: true, id, state: session.meta.state, signal: session.meta.signal ?? null, exited: session.meta.state === "exited", alreadyExited: true, terminationVerified: session.meta.terminationVerified === true, forced: false, exitCode: session.meta.exitCode ?? null };
  }

  await session.identityReady;

  const initialSignal = process.platform === "win32" ? "SIGTERM" : ((signal ?? "SIGTERM") as NodeJS.Signals);
  const treeTermination = session.meta.processIdentity
    ? await terminateVerifiedProcessTreeDetailedAsync(
      session.meta.pid,
      session.meta.processIdentity,
      session.meta.createdAt,
      1000,
      initialSignal,
      "RCMCP_PTY_SESSION_ID=" + session.meta.id,
    )
    : { terminated: false, forced: false, verification: undefined, verificationScope: undefined, reason: undefined };
  const treeTerminationVerified = treeTermination.terminated;
  let forced = treeTermination.forced;
  // taskkill stops the process tree, but the pseudoconsole still owns pipe handles.
  // Close it explicitly so node-pty can drain output and publish its exit event.
  const windowsRootStopped = process.platform === "win32" && (
    ("rootStopped" in treeTermination && treeTermination.rootStopped === true) || !processAlive(session.meta.pid)
  );
  if (process.platform === "win32" && (treeTerminationVerified || windowsRootStopped)) closeVerifiedWindowsPty(session.terminal);

  if (!treeTerminationVerified && !windowsRootStopped) {
    if (process.platform === "win32") session.terminal.kill();
    else session.terminal.kill(signal);

    let shellExited = await waitForExit(session, 500);
    if (!shellExited && process.platform !== "win32" && signal !== "SIGKILL") {
      forced = true;
      session.terminal.kill("SIGKILL");
      shellExited = await waitForExit(session, 500);
    }
    if (!shellExited) throw new Error("PTY session " + id + " did not exit after termination");
  }

  // node-pty Windows drains output for 1000ms after process exit. Allow that
  // native flush window plus scheduling margin before requiring its exit event.
  let exited = await waitForExit(session, process.platform === "win32" ? 2500 : 500);
  if (!exited && treeTerminationVerified) exited = await waitForExit(session, 500);
  if (!exited) throw new Error("PTY session " + id + " process tree terminated but terminal exit was not observed");

  const meta = readMeta(id);
  meta.terminationVerified = meta.state === "exited" && treeTerminationVerified;
  meta.terminationVerification = treeTermination.verification ?? null;
  meta.terminationVerificationScope = treeTermination.verificationScope ?? null;
  meta.terminationReason = treeTermination.reason ?? null;
  writeMetaRecoverably(meta, "pty_termination_proof_persistence_failed");
  const terminalStateExited = meta.state === "exited";
  return {
    ok: true, id, state: meta.state,
    signal: process.platform === "win32" ? "default" : (signal ?? "default"),
    exited: terminalStateExited, terminationVerified: terminalStateExited && treeTerminationVerified, alreadyExited: false, forced,
    exitCode: meta.exitCode ?? null, exitSignal: meta.signal ?? null,
    terminationVerification: treeTermination.verification ?? null,
    terminationVerificationScope: treeTermination.verificationScope ?? null,
    terminationReason: treeTermination.reason ?? null,
    recoveryReason: meta.recoveryReason ?? null,
  };
}

export function ptyList() {
  return readdirSync(ptyRoot).filter((name) => name.endsWith(".json")).map((name) => {
    const meta = readMeta(name.slice(0, -5));
    const live = sessions.get(meta.id);
    const totalBytes = existsSync(meta.outputPath) ? statSync(meta.outputPath).size : 0;
    return {
      id: meta.id, pid: meta.pid, shell: meta.shell, cwd: meta.cwd, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      cols: live?.terminal.cols ?? meta.cols, rows: live?.terminal.rows ?? meta.rows,
      state: meta.state, exited: meta.state === "exited", terminationVerified: meta.state === "exited" && meta.terminationVerified === true,
      exitCode: meta.exitCode ?? null, signal: meta.signal ?? null,
      outputBytes: totalBytes, recoveryReason: meta.recoveryReason ?? null,
    };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function ptyRemove(id: string, force = false) {
  const meta = readMeta(id);
  if (sessions.has(id) && meta.state === "running") {
    if (!force) throw new Error("PTY session is still running; terminate it or use force=true");
    await ptyTerminate(id);
  }
  sessions.delete(id);
  await releaseWindowsProcessTracker(meta.pid, meta.processIdentity);
  volatileMeta.delete(id);
  rmSync(metaPath(id), { force: true });
  rmSync(meta.outputPath, { force: true });
  return { id, removed: true };
}
