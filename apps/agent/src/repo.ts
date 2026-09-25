import { execFile, spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import pathModule from "node:path";
import process from "node:process";
import { currentProcessIdentityAsync, terminateVerifiedProcessTreeDetailedAsync } from "./process-identity.ts";
import { promisify } from "node:util";
import { runtimeEnv } from "./runtime-env.ts";

const execFileAsync = promisify(execFile);

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; }
  catch { return false; }
}

async function isDirectory(target: string): Promise<boolean> {
  try { return (await stat(target)).isDirectory(); }
  catch { return false; }
}

export async function resolveRepoSafeDirectory(repoPath: string): Promise<string> {
  let current = await realpath(repoPath).catch(() => pathModule.resolve(repoPath));
  while (true) {
    if (await exists(pathModule.join(current, ".git"))) return current;
    if (await exists(pathModule.join(current, "HEAD")) && await isDirectory(pathModule.join(current, "objects"))) return current;
    const parent = pathModule.dirname(current);
    if (parent === current) return await realpath(repoPath).catch(() => pathModule.resolve(repoPath));
    current = parent;
  }
}

function needsSafeDirectory(): boolean {
  if (process.platform === "win32") {
    return (process.env.RCMCP_RUNTIME_CONTEXT ?? "").toLowerCase() === "system"
      || (process.env.USERNAME ?? "").toUpperCase() === "SYSTEM";
  }
  return typeof process.geteuid === "function" && process.geteuid() === 0;
}

async function gitPrefix(repoPath: string): Promise<string[]> {
  return needsSafeDirectory()
    ? ["-c", `safe.directory=${await resolveRepoSafeDirectory(repoPath)}`]
    : [];
}

export function gitNetworkEnvironment(): NodeJS.ProcessEnv {
  return runtimeEnv({
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    SSH_ASKPASS_REQUIRE: "never",
  });
}

export function redactGitText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|auth(?:entication)?|credential|pass(?:word)?|secret|token|private[_-]?key)=)[^&#\s]*/gi, "$1***");
}

async function terminateGitTree(pid: number, identityPromise: Promise<string | null>): Promise<void> {
  if (process.platform === "win32") {
    const identity = await identityPromise.catch(() => null);
    if (identity) {
      await terminateVerifiedProcessTreeDetailedAsync(pid, identity, undefined, 1000, "SIGKILL").catch(() => undefined);
    } else {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true, timeout: 5000,
      }).catch(() => undefined);
    }
    return;
  } else {
    try { process.kill(-pid, "SIGKILL"); return; } catch { /* fall through */ }
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function runGitNetwork(repoPath: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const safeArgs = await gitPrefix(repoPath);
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...safeArgs, "-c", "credential.interactive=never", "-C", repoPath, ...args], {
      env: gitNetworkEnvironment(),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBytes = 16 * 1024 * 1024;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let spawnError: Error | null = null;
    let settled = false;
    let terminationDeadline: NodeJS.Timeout | undefined;
    const identityPromise = child.pid ? currentProcessIdentityAsync(child.pid) : Promise.resolve(null);

    const collect = (chunks: Buffer[], chunk: Buffer, used: number) => {
      const remaining = Math.max(0, maxBytes - used);
      if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
      return used + chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = collect(stdoutChunks, chunk, stdoutBytes); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = collect(stderrChunks, chunk, stderrBytes); });
    child.once("error", (error) => { spawnError = error; });

    const timer = setTimeout(() => {
      timedOut = true;
      const stopRoot = () => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* reported as unverified below */ }
        }
      };
      // Never wait forever for close: a denied termination or inherited pipe
      // can outlive the transport. Bound the response and report uncertainty.
      terminationDeadline = setTimeout(() => {
        if (settled) return;
        stopRoot();
        settled = true;
        child.stdout?.destroy(); child.stderr?.destroy();
        reject(Object.assign(new Error(`Git timed out after ${timeoutMs}ms; termination unverified, process or descendants may still be running`), {
          code: "ETIMEDOUT", killed: child.exitCode !== null || child.signalCode !== null,
          terminationVerified: false,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        }));
      }, 1500);
      if (child.pid) void terminateGitTree(child.pid, identityPromise).catch(() => undefined).finally(stopRoot);
    }, timeoutMs);
    timer.unref();

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (terminationDeadline) clearTimeout(terminationDeadline);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (spawnError) {
        const detail = Object.assign(spawnError, { stdout, stderr, killed: false });
        reject(detail);
        return;
      }
      if (timedOut) {
        const detail = Object.assign(new Error(`Git timed out after ${timeoutMs}ms; root exited, descendant termination is not independently verified`), {
          code: "ETIMEDOUT", killed: true, stdout, stderr, signal,
        });
        reject(detail);
        return;
      }
      if (code !== 0) {
        const detail = Object.assign(new Error(`Git exited with code ${code ?? "unknown"}`), {
          code: code ?? "unknown", killed: false, stdout, stderr, signal,
        });
        reject(detail);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function git(repoPath: string, args: string[], allowFailure = false): Promise<string | null> {
  try {
    const safeArgs = await gitPrefix(repoPath);
    const { stdout } = await execFileAsync("git", [...safeArgs, "-C", repoPath, ...args], {
      env: runtimeEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

export async function gitRaw(repoPath: string, args: string[], options: {
  env?: Record<string, string>; stdin?: string; allowExitOne?: boolean; allowNonZero?: boolean;
} = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const prefix = await gitPrefix(repoPath);
  const pending = execFileAsync("git", [...prefix, "-C", repoPath, ...args], {
    env: runtimeEnv(options.env), windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  pending.child.stdin?.on("error", () => { /* Git may reject arguments before reading stdin. */ });
  pending.child.stdin?.end(options.stdin);
  try {
    const result = await pending;
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string; code?: number };
    if ((options.allowExitOne && detail.code === 1) || (options.allowNonZero && typeof detail.code === "number" && detail.code > 0)) {
      return { stdout: detail.stdout ?? "", stderr: detail.stderr ?? "", code: detail.code! };
    }
    throw error;
  }
}

export async function repoGitPath(path: string, gitPath: string) {
  const root = await git(path, ["rev-parse", "--show-toplevel"]);
  const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"]);
  const commonGitDir = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const resolved = await git(path, ["rev-parse", "--path-format=absolute", "--git-path", gitPath]);
  return { root, gitDir, commonGitDir, gitPath, resolved };
}

export type RepoSnapshotSummary = {
  profile: "summary";
  root: string | null;
  head: string | null;
  shortHead: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  changedCount: number;
};

export type RepoSnapshotFull = Omit<RepoSnapshotSummary, "profile"> & {
  profile: "full";
  gitDir: string | null;
  commonGitDir: string | null;
  status: string[];
  diffStat: string[];
  stagedDiffStat: string[];
  remotes: string[];
  recent: Array<{ sha: string | undefined; date: string | undefined; message: string }>;
};

export async function repoSnapshot(path: string, logCount?: number, profile?: "full"): Promise<RepoSnapshotFull>;
export async function repoSnapshot(path: string, logCount: number | undefined, profile: "summary"): Promise<RepoSnapshotSummary>;
export async function repoSnapshot(
  path: string,
  logCount = 8,
  profile: "summary" | "full" = "full",
): Promise<RepoSnapshotSummary | RepoSnapshotFull> {
  const [root, head, branch, upstream, status] = await Promise.all([
    git(path, ["rev-parse", "--show-toplevel"]),
    git(path, ["rev-parse", "HEAD"], true),
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"], true),
    git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], true),
    git(path, ["status", "--porcelain=v1", "-b"]),
  ]);
  const statusLines = status?.split(/\r?\n/).filter(Boolean) ?? [];
  const changedCount = statusLines.slice(1).length;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await git(path, ["rev-list", "--left-right", "--count", upstream + "...HEAD"], true);
    if (counts) {
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behind = Number(behindRaw ?? 0);
      ahead = Number(aheadRaw ?? 0);
    }
  }

  const summaryBase = {
    root,
    head,
    shortHead: head?.slice(0, 12) ?? null,
    branch,
    upstream,
    ahead,
    behind,
    clean: changedCount === 0,
    changedCount,
  };
  if (profile === "summary") return { profile: "summary" as const, ...summaryBase };

  const [gitDir, commonGitDir, diffStat, stagedDiffStat, remotes, recent] = await Promise.all([
    git(path, ["rev-parse", "--absolute-git-dir"]),
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(path, ["diff", "--stat"]),
    git(path, ["diff", "--cached", "--stat"]),
    git(path, ["remote", "-v"], true),
    git(path, ["log", "-n", String(Math.max(1, Math.min(logCount, 50))), "--pretty=format:%h%x09%ad%x09%s", "--date=iso-strict"], true),
  ]);
  return {
    profile: "full" as const,
    ...summaryBase,
    gitDir,
    commonGitDir,
    status: statusLines,
    diffStat: diffStat?.split(/\r?\n/).filter(Boolean) ?? [],
    stagedDiffStat: stagedDiffStat?.split(/\r?\n/).filter(Boolean) ?? [],
    remotes: remotes?.split(/\r?\n/).filter(Boolean) ?? [],
    recent: recent?.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, date, ...message] = line.split("\t");
      return { sha, date, message: message.join("\t") };
    }) ?? [],
  };
}

export { repoCheckpoint } from "./repo-edit.ts";

export async function repoFetch(input: { path: string; remote?: string; refspecs?: string[]; prune?: boolean; tags?: boolean; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const remote = input.remote ?? "origin";
  const args = ["fetch"];
  if (input.prune) args.push("--prune");
  if (input.tags) args.push("--tags");
  args.push("--", remote, ...(input.refspecs ?? []));
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await runGitNetwork(input.path, args, timeoutMs);
    return {
      ok: true, operation: "fetch", remote: redactGitText(remote), nonInteractive: true, timeoutMs,
      durationMs: Date.now() - startedAt,
      summary: redactGitText([stdout, stderr].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024),
    };
  } catch (error) {
    const detail = error as Error & { code?: string | number; killed?: boolean; stderr?: string; stdout?: string };
    const output = redactGitText([detail.stderr, detail.stdout, detail.message].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024);
    throw new Error(`Git fetch ${detail.code === "ETIMEDOUT" || detail.killed ? `timed out after ${timeoutMs}ms` : `failed with exit ${detail.code ?? "unknown"}`}${output ? `: ${output}` : ""}`);
  }
}

export async function repoPull(input: { path: string; remote?: string; refspecs?: string[]; ffOnly?: boolean; tags?: boolean; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const args = ["pull"];
  if (input.ffOnly !== false) args.push("--ff-only");
  if (input.tags) args.push("--tags");
  if (input.remote) args.push("--", input.remote, ...(input.refspecs ?? []));
  else if (input.refspecs?.length) throw new Error("Git pull refspecs require an explicit remote");
  const safeArgs = await gitPrefix(input.path);
  const beforeHead = await git(input.path, ["rev-parse", "HEAD"], true);
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await runGitNetwork(input.path, args, timeoutMs);
    const afterHead = await git(input.path, ["rev-parse", "HEAD"], true);
    return {
      ok: true, operation: "pull", remote: input.remote ? redactGitText(input.remote) : null,
      nonInteractive: true, timeoutMs, durationMs: Date.now() - startedAt, beforeHead, afterHead,
      headChanged: beforeHead !== afterHead,
      summary: redactGitText([stdout, stderr].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024),
    };
  } catch (error) {
    const detail = error as Error & { code?: string | number; killed?: boolean; stderr?: string; stdout?: string };
    const output = redactGitText([detail.stderr, detail.stdout, detail.message].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024);
    throw new Error(`Git pull ${detail.code === "ETIMEDOUT" || detail.killed ? `timed out after ${timeoutMs}ms` : `failed with exit ${detail.code ?? "unknown"}`}${output ? `: ${output}` : ""}`);
  }
}

export async function repoPush(input: { path: string; remote?: string; refspecs?: string[]; setUpstream?: boolean; tags?: boolean; dryRun?: boolean; timeoutMs?: number }) {
  const timeoutMs = input.timeoutMs ?? 60_000;
  const remote = input.remote ?? "origin";
  const args = ["push"];
  if (input.setUpstream) args.push("--set-upstream");
  if (input.tags) args.push("--tags");
  if (input.dryRun) args.push("--dry-run");
  args.push("--", remote, ...(input.refspecs ?? []));
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await runGitNetwork(input.path, args, timeoutMs);
    return {
      ok: true, operation: "push", remote: redactGitText(remote), nonInteractive: true, timeoutMs,
      durationMs: Date.now() - startedAt,
      summary: redactGitText([stdout, stderr].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024),
    };
  } catch (error) {
    const detail = error as Error & { code?: string | number; killed?: boolean; stderr?: string; stdout?: string };
    const output = redactGitText([detail.stderr, detail.stdout, detail.message].filter(Boolean).join("\n")).trim().slice(0, 32 * 1024);
    throw new Error(`Git push ${detail.code === "ETIMEDOUT" || detail.killed ? `timed out after ${timeoutMs}ms` : `failed with exit ${detail.code ?? "unknown"}`}${output ? `: ${output}` : ""}`);
  }
}
