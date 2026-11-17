import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { coordinationHookFailureSchema, type CoordinationHookFailure } from "../../../packages/protocol/src/coordination.ts";
import { gitPrefix, redactGitText } from "./repo.ts";
import { runtimeEnv } from "./runtime-env.ts";

/** A failed Git command boundary is evidence, never a licence to replay it. */
export class RepoHookFailureError extends Error {
  readonly failure: CoordinationHookFailure;
  constructor(message: string, failure: CoordinationHookFailure) {
    super(message);
    this.name = "RepoHookFailureError";
    this.failure = failure;
  }
}

export function hookFailureFromError(error: unknown): CoordinationHookFailure | undefined {
  return error instanceof RepoHookFailureError ? error.failure : undefined;
}

type GitCommandOutcome = {
  code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean;
  pid?: number; groupAtStart: "exists" | "absent" | "unknown"; groupAfterExit: "exists" | "absent" | "unknown";
};

const MAX_OUTPUT_BYTES = 256 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

async function runGitCommand(repoPath: string, args: string[], options: {
  env?: Record<string, string>; stdin?: string; config?: string[]; detached?: boolean; timeoutMs?: number;
} = {}): Promise<GitCommandOutcome> {
  const prefix = await gitPrefix(repoPath);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...(options.config ?? []), ...prefix, "-C", repoPath, ...args], {
      env: runtimeEnv(options.env), windowsHide: true,
      detached: options.detached === true && process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [], stderrChunks: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, timedOut = false, settled = false, spawnError: Error | null = null;
    const collect = (chunks: Buffer[], chunk: Buffer, used: number) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - used);
      if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      return used + chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = collect(stderrChunks, chunk, stderrBytes); });
    child.once("error", (error) => { spawnError = error; finish(); });
    child.stdin?.on("error", () => { /* Git may reject arguments before reading stdin. */ });
    child.stdin?.end(options.stdin ?? "");
    let groupAtStart: "exists" | "absent" | "unknown" = "unknown";
    // A detached child leads its own process group. Confirm that the group
    // exists once the child is spawned: only the leader can own a group whose
    // id is its own pid, so an absent group later proves "no surviving
    // descendant" instead of "no group was ever created".
    child.once("spawn", () => { groupAtStart = options.detached === true ? probeGroup(child.pid) : "unknown"; });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; killGroup(child.pid); }, options.timeoutMs) : undefined;
    timer?.unref();
    let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
    let groupAfterExit: "exists" | "absent" | "unknown" = "unknown";
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (closeDeadline) clearTimeout(closeDeadline);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8"), stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError) { reject(Object.assign(spawnError, { stdout, stderr })); return; }
      resolve({ code: exitCode, signal: exitSignal, stdout, stderr, timedOut, pid: child.pid, groupAtStart, groupAfterExit });
    };
    child.once("exit", (code, signal) => {
      exitCode = code; exitSignal = signal;
      // Probe the group as soon as the command itself exited: a descendant that
      // still holds the output pipe must not be mistaken for an empty group.
      groupAfterExit = options.detached === true ? probeGroup(child.pid) : "unknown";
      // A surviving descendant keeps the pipes open. Bound the wait instead of
      // blocking the caller until that descendant ends.
      closeDeadline = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, 1500);
      closeDeadline.unref();
    });
    child.once("close", () => { finish(); });
  });
}

function killGroup(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* the root is already gone */ }
}

/** POSIX process-group probe: "exists" also covers a group we may not signal. */
function probeGroup(pid: number | undefined): "exists" | "absent" | "unknown" {
  if (process.platform === "win32" || !pid || pid <= 0) return "unknown";
  try { process.kill(-pid, 0); return "exists"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    return "unknown";
  }
}

type HookPlan = { config?: string[]; statusDirectory?: string; names: string[] };

async function effectiveHooksPath(repoPath: string): Promise<string | null> {
  const configured = await runGitCommand(repoPath, ["config", "--path", "--get", "core.hooksPath"]);
  if (configured.code === 0) {
    const value = configured.stdout.trim();
    if (!value) return null;
    return path.isAbsolute(value) ? value : path.resolve(repoPath, value);
  }
  const resolved = await runGitCommand(repoPath, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  if (resolved.code !== 0) return null;
  return resolved.stdout.trim() || null;
}

/** Observe the exact hook exit status by wrapping the repository's own hooks.
 * The wrapper executes the original hook unchanged and only records its exit
 * code. When the hook set cannot be mirrored exactly, no wrapper is used and
 * the observation stays unavailable: a guard hook is never skipped. */
async function prepareHookObservation(repoPath: string): Promise<HookPlan> {
  if (process.platform === "win32") return { names: [] };
  const hooksPath = await effectiveHooksPath(repoPath);
  if (!hooksPath) return { names: [] };
  let entries: string[];
  try { entries = readdirSync(hooksPath); } catch { return { names: [] }; }
  const hooks = entries.filter(name => !name.endsWith(".sample")).filter(name => {
    try { const stat = statSync(path.join(hooksPath, name)); return stat.isFile() && (stat.mode & 0o111) !== 0; }
    catch { return false; }
  }).sort();
  if (!hooks.length) return { names: [] };
  let directory: string | null = null;
  try {
    directory = mkdtempSync(path.join(os.tmpdir(), "rcmcp-hook-observation-"));
    for (const name of hooks) {
      const original = path.join(hooksPath, name);
      const status = path.join(directory, name + ".status");
      writeFileSync(path.join(directory, name), [
        "#!/bin/sh",
        "# Records the hook exit status and propagates it unchanged.",
        shellQuote(original) + " \"$@\"",
        "__rcmcp_hook_status=$?",
        `printf '%s\\n' "$__rcmcp_hook_status" > ${shellQuote(status)}`,
        "exit $__rcmcp_hook_status",
        "",
      ].join("\n"), { mode: 0o700 });
      chmodSync(path.join(directory, name), 0o700);
    }
    const wrapped = readdirSync(directory).filter(name => !name.endsWith(".status")).sort();
    // Fail closed: a partially mirrored hook set would silently skip a guard.
    if (wrapped.length !== hooks.length || hooks.some((name, index) => wrapped[index] !== name)) {
      rmSync(directory, { recursive: true, force: true });
      return { names: hooks };
    }
    return { config: ["-c", `core.hooksPath=${directory}`], statusDirectory: directory, names: hooks };
  } catch {
    if (directory) rmSync(directory, { recursive: true, force: true });
    return { names: hooks };
  }
}

function readHookStatuses(directory: string | undefined, names: string[]): Map<string, number> {
  const statuses = new Map<string, number>();
  if (!directory) return statuses;
  for (const name of names) {
    try {
      const code = Number(readFileSync(path.join(directory, name + ".status"), "utf8").trim());
      if (Number.isInteger(code)) statuses.set(name, code);
    } catch { /* the hook never completed */ }
  }
  return statuses;
}

const hookBoundaryNames: Record<string, CoordinationHookFailure["hook"]["boundary"]> = {
  "pre-commit": "pre_commit", "prepare-commit-msg": "prepare_commit_msg",
  "commit-msg": "commit_msg", "post-commit": "post_commit",
};
const hookOrder = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];

type RepoObservation = { head: string | null; reflog: string | null; index: string | null; worktree: string | null };

async function observeRepository(repoPath: string): Promise<RepoObservation> {
  const head = await runGitCommand(repoPath, ["rev-parse", "--verify", "HEAD"]);
  const reflog = await runGitCommand(repoPath, ["reflog", "-1", "--format=%H%x00%gs"]);
  const index = await runGitCommand(repoPath, ["ls-files", "--stage", "-v", "-z"]);
  const worktree = await runGitCommand(repoPath, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  return {
    head: head.code === 0 ? head.stdout.trim().slice(0, 64) : null,
    reflog: reflog.code === 0 ? reflog.stdout.trim().slice(0, 512) : null,
    index: index.code === 0 ? digest(index.stdout) : null,
    worktree: worktree.code === 0 ? digest(worktree.stdout) : null,
  };
}

/** A failed hook, an unchanged HEAD, an elapsed lease or a missing job never
 * proves the absence of an effect. Only the complete, matching observation
 * set does. */
export function classifyHookFailure(input: {
  code: number | null; signal: NodeJS.Signals | null; timedOut: boolean;
  before: RepoObservation | null; after: RepoObservation | null; containment: CoordinationHookFailure["containment"];
}): CoordinationHookFailure["classification"] {
  if (input.code === null || input.signal || input.timedOut) return "unverified";
  if (!input.containment.verified) return "unverified";
  if (!input.before || !input.after) return "unverified";
  if (input.before.index === null || input.after.index === null
    || input.before.worktree === null || input.after.worktree === null) return "unverified";
  const changed = input.before.head !== input.after.head || input.before.reflog !== input.after.reflog
    || input.before.index !== input.after.index || input.before.worktree !== input.after.worktree;
  return changed ? "partially_applied" : "pre_effect";
}

export type ObservedCommit = {
  code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; failure?: CoordinationHookFailure;
};

/** Run one Git command boundary and describe its failure. The observation is
 * invocation-bound: it belongs to this command, this repository state and this
 * process group. It never authorises a replay. */
export async function runObservedCommit(options: {
  repoPath: string; args: string[]; flags: string[]; env?: Record<string, string>; stdin?: string;
  message: "provided" | "generated";
}): Promise<ObservedCommit> {
  const plan = await prepareHookObservation(options.repoPath);
  // Without an executable hook no hook can fail; the repository observations
  // are then only collected for a failure that already happened.
  const before = plan.names.length > 0 ? await observeRepository(options.repoPath) : null;
  let outcome!: GitCommandOutcome;
  let statuses!: Map<string, number>;
  try {
    outcome = await runGitCommand(options.repoPath, options.args, {
      env: options.env, stdin: options.stdin, config: plan.config, detached: true,
    });
    statuses = readHookStatuses(plan.statusDirectory, plan.names);
  } finally {
    if (plan.statusDirectory) rmSync(plan.statusDirectory, { recursive: true, force: true });
  }
  if (outcome.code === 0 && !outcome.signal && !outcome.timedOut) {
    return { code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut };
  }
  // The group was probed as soon as the command exited: a surviving descendant
  // keeps the effect unverified even when the command itself already failed.
  const group = outcome.groupAtStart === "exists" ? outcome.groupAfterExit : "unknown";
  const containment: CoordinationHookFailure["containment"] = group === "absent"
    ? { verified: true, detail: "process_group_empty" }
    : group === "exists" ? { verified: false, detail: "descendants_present" }
      : { verified: false, detail: "unavailable" };
  const after = before ? await observeRepository(options.repoPath) : null;
  let boundary: CoordinationHookFailure["hook"]["boundary"] = "none";
  let exitCode: number | null = outcome.code;
  let exitCodeSource: CoordinationHookFailure["hook"]["exitCodeSource"] = "command";
  for (const name of hookOrder) {
    const status = statuses.get(name);
    if (status === undefined || status === 0) continue;
    boundary = hookBoundaryNames[name] ?? "unavailable";
    exitCode = status; exitCodeSource = "hook";
    break;
  }
  if (exitCodeSource === "command") {
    const failed = [...statuses.entries()].find(([, status]) => status !== 0);
    if (failed) { boundary = "unavailable"; exitCode = failed[1]; exitCodeSource = "hook"; }
  }
  const output = redactGitText([outcome.stderr, outcome.stdout].filter(Boolean).join("\n")).trim().slice(0, 4096);
  const failure = coordinationHookFailureSchema.parse({
    version: 1,
    command: { boundary: "commit", flags: options.flags, message: options.message },
    hook: { boundary, exitCode, exitCodeSource, ...(output ? { output } : {}) },
    refs: { beforeHead: before?.head ?? null, afterHead: after?.head ?? null, beforeReflog: before?.reflog ?? null, afterReflog: after?.reflog ?? null },
    index: { before: before?.index ?? null, after: after?.index ?? null, changed: before?.index == null || after?.index == null ? null : before.index !== after.index },
    worktree: { before: before?.worktree ?? null, after: after?.worktree ?? null, changed: before?.worktree == null || after?.worktree == null ? null : before.worktree !== after.worktree },
    containment,
    classification: classifyHookFailure({ code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut, before, after, containment }),
    observedAt: new Date().toISOString(),
  });
  return { code: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut, failure };
}
