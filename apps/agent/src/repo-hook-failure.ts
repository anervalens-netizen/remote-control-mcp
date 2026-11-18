import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { coordinationHookFailureSchema, type CoordinationHookFailure } from "../../../packages/protocol/src/coordination.ts";
import { gitPrefix, gitRaw } from "./repo.ts";
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
  code: number | null; stdout: Buffer; stdoutTruncated: boolean; timedOut: boolean;
};

const MAX_OUTPUT_BYTES = 256 * 1024;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function runObservation(repoPath: string, args: string[]): Promise<GitCommandOutcome> {
  const prefix = await gitPrefix(repoPath);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...prefix, "-c", "core.fsmonitor=false", "-C", repoPath, ...args], {
      env: runtimeEnv({ GIT_OPTIONAL_LOCKS: "0" }), windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0, stdoutIncomplete = false, timedOut = false, settled = false, spawnError: Error | null = null;
    const collect = (chunks: Buffer[], chunk: Buffer, used: number) => {
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - used);
      if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      return used + chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes); });
    child.once("error", (error) => { spawnError = error; finish(); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill();
      else killGroup(child.pid);
    }, 3000);
    timer.unref();
    let exitCode: number | null = null;
    let closeDeadline: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeDeadline) clearTimeout(closeDeadline);
      if (spawnError) { reject(spawnError); return; }
      resolve({ code: exitCode, stdout: Buffer.concat(stdoutChunks),
        stdoutTruncated: stdoutIncomplete || stdoutBytes > MAX_OUTPUT_BYTES, timedOut });
    };
    child.once("exit", code => {
      clearTimeout(timer);
      exitCode = code;
      closeDeadline = setTimeout(() => {
        stdoutIncomplete = true;
        child.stdout?.destroy();
        finish();
      }, 1500);
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

type RepoObservation = { head: string | null; reflog: string | null; index: string | null; worktreeStatus: string | null };

async function observeRepository(repoPath: string): Promise<RepoObservation> {
  const observe = async (args: string[]) => {
    const result = await runObservation(repoPath, args).catch(() => null);
    return result?.code === 0 && !result.timedOut && !result.stdoutTruncated ? result.stdout : null;
  };
  const [headBytes, reflog, index, worktreeStatus] = await Promise.all([
    observe(["rev-parse", "--verify", "HEAD"]),
    observe(["reflog", "-1", "--format=%H%x00%gs"]),
    observe(["ls-files", "--stage", "-v", "-z"]),
    observe(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]),
  ]);
  const head = headBytes?.toString("ascii").trim();
  return {
    head: head && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ? head : null,
    reflog: reflog ? digest(reflog) : null,
    index: index ? digest(index) : null,
    worktreeStatus: worktreeStatus ? digest(worktreeStatus) : null,
  };
}

function observedChange(before: string | null, after: string | null): boolean | null {
  return before === null || after === null ? null : before !== after;
}

/** Git metadata is diagnostic only.
 * Preserve the existing hooksPath and execute the commit once. */
export async function runObservedCommit(options: {
  repoPath: string; args: string[]; flags: string[]; env?: Record<string, string>; stdin?: string;
  message: "provided" | "generated";
}) {
  const before = await observeRepository(options.repoPath);
  const outcome = await gitRaw(options.repoPath, options.args, {
    env: options.env, stdin: options.stdin, allowNonZero: true,
  }).catch(() => null);
  if (outcome?.code === 0) return {};
  const exitCode = outcome?.code ?? null;
  const after = await observeRepository(options.repoPath);
  const indexChanged = observedChange(before.index, after.index);
  const statusChanged = observedChange(before.worktreeStatus, after.worktreeStatus);
  const changed = observedChange(before.head, after.head) === true
    || observedChange(before.reflog, after.reflog) === true || indexChanged === true || statusChanged === true;

  const failure = coordinationHookFailureSchema.parse({
    version: 1,
    command: { boundary: "commit", flags: options.flags, message: options.message },
    hook: { boundary: "unavailable", exitCode, exitCodeSource: exitCode === null ? "unavailable" : "command" },
    refs: { beforeHead: before.head, afterHead: after.head, beforeReflog: before.reflog, afterReflog: after.reflog },
    index: { before: before.index, after: after.index, changed: indexChanged },
    worktree: { before: before.worktreeStatus, after: after.worktreeStatus, changed: statusChanged === true ? true : null },
    containment: { verified: false, detail: "unavailable" },
    classification: changed ? "partially_applied" : "unverified",
    observedAt: new Date().toISOString(),
  });
  return { failure };
}
