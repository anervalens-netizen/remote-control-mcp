import { copyFile, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RepoCheckpointInput, RepoPatchInput } from "../../../packages/protocol/src/editing.ts";
import { gitRaw } from "./repo.ts";
import { syncContainingDirectory } from "./filesystem-atomic.ts";

type Change = { status: string; path: string; originalPath?: string };
export function checkpointChanges(porcelain: string): Change[] {
  const entries = porcelain.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const change: Change = { status: status[0]!, path: entry.slice(3) };
    if (status.includes("R") || status.includes("C")) change.originalPath = entries[++i]!;
    if (status[0] !== " " && status[0] !== "?" && status[0] !== "!") changes.push(change);
  }
  return changes;
}

export async function repoCheckpoint(input: RepoCheckpointInput) {
  const mode = input.mode ?? (input.paths ? "paths" : "all");
  if (mode === "paths" && !input.paths?.length) throw new Error("paths is required when mode=paths");
  if (mode !== "paths" && input.paths) throw new Error("paths requires mode=paths");
  const run = (args: string[]) => gitRaw(input.path, args);
  const indexPath = (await run(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trimEnd();
  // Use Git's own lock convention. Other Git writers cannot race our index
  // installation, and a failed add/hook/commit leaves the original index intact.
  const lockPath = indexPath + ".lock";
  const lock = await open(lockPath, "wx");
  const temporary = indexPath + ".rcmcp-" + randomUUID();
  let preserveTemporary = false;
  let ownsLock = true;
  try {
    await lock.close();
    const before = await run(["rev-parse", "--verify", "HEAD"]).then(r => r.stdout.trim(), () => null);
    try { await copyFile(indexPath, temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const env = { GIT_INDEX_FILE: temporary };
    const git = (args: string[], stdin?: string, allowNoChanges = false) => gitRaw(input.path, args, { env, stdin, allowExitOne: allowNoChanges });
    const pathArgs = mode === "paths" ? ["--pathspec-from-file=-", "--pathspec-file-nul"] : [];
    const pathInput = mode === "paths" ? input.paths!.join("\0") + "\0" : undefined;
    if (mode !== "staged") {
      await git(["add", input.includeUntracked === false ? "-u" : "-A", ...pathArgs], pathInput);
    }
    const selection = mode === "paths" ? ["--only", ...pathArgs] : [];
    const preview = await git(["commit", "--dry-run", "--porcelain", "-z", ...selection], pathInput, true);
    const changes = checkpointChanges(preview.stdout);
    if (preview.code !== 0 && (preview.stderr.trim() || changes.some(c => c.status === "U"))) {
      throw new Error(preview.stderr.trim() || "Checkpoint has unmerged changes");
    }
    const result = { before, head: before, mode, changes, staged: changes.map(c => c.status + "\t" + c.path) };
    if (input.dryRun) return { ...result, created: false, dryRun: true, wouldCreate: changes.length > 0 || input.allowEmpty === true };
    if (!changes.length && !input.allowEmpty) return { ...result, created: false, reason: "no_changes" };
    const args = ["commit", "-m", input.message ?? `checkpoint ${new Date().toISOString()}`, ...selection];
    if (input.allowEmpty) args.push("--allow-empty");
    await git(args, pathInput);
    const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
    // Native --only retains unrelated staged entries in the temporary index.
    // Install that index only after a successful commit.
    try {
      const file = await open(temporary, "r+");
      try { await file.sync(); } finally { await file.close(); }
      await rename(temporary, lockPath);
      await rename(lockPath, indexPath);
      ownsLock = false; // The lock was consumed; another Git writer may own this path now.
      const durability = await syncContainingDirectory(indexPath);
      return { ...result, created: true, head, indexUpdated: true, directorySynced: durability.synced };
    } catch (error) {
      preserveTemporary = true;
      // A commit is already real: expose recovery, never invite a blind retry.
      return { ...result, created: true, head, indexUpdated: false,
        recoveryIndexPath: temporary, recoveryLockPath: lockPath,
        error: error instanceof Error ? error.message : String(error) };
    }
  } finally {
    await lock.close().catch(() => undefined);
    if (!preserveTemporary) {
      await rm(temporary, { force: true });
      if (ownsLock) await rm(lockPath, { force: true });
    }
  }
}

export async function repoApplyPatch(input: RepoPatchInput) {
  const target = input.target ?? "worktree";
  const args = ["apply", "--whitespace=" + (input.whitespace ?? "nowarn")];
  if (target === "index") args.push("--cached");
  if (target === "both") args.push("--index");
  if (input.reverse) args.push("--reverse");
  if (input.strip !== undefined) args.push("-p" + input.strip);
  if (input.directory !== undefined) args.push("--directory=" + input.directory);
  if (input.unidiffZero) args.push("--unidiff-zero");
  const checked = await gitRaw(input.path, [...args, "--check", "-"], { stdin: input.patch, allowNonZero: true });
  if (checked.code !== 0) return { ok: false, applied: false, checkOnly: input.checkOnly ?? false, target, exitCode: checked.code, error: checked.stderr.trim() || "git apply check failed" };
  if (input.checkOnly) return { ok: true, applied: false, checkOnly: true, target, summary: checked.stderr.trim() };
  // git apply checks all hunks again before writing; no --reject/partial mode.
  const applied = await gitRaw(input.path, [...args, "-"], { stdin: input.patch, allowNonZero: true });
  return { ok: applied.code === 0, applied: applied.code === 0, checkOnly: false, target,
    ...(applied.code === 0 ? { summary: applied.stderr.trim() } : { exitCode: applied.code, error: applied.stderr.trim() || "git apply failed" }) };
}
