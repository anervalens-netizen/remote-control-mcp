import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({ onSync: undefined as undefined | ((target: string) => Promise<void>) }));
vi.mock("../apps/agent/src/filesystem-atomic.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps/agent/src/filesystem-atomic.ts")>();
  return { ...actual, syncContainingDirectory: async (target: string) => {
    await hook.onSync?.(target);
    return actual.syncContainingDirectory(target);
  } };
});
import { repoCheckpoint } from "../apps/agent/src/repo-edit.ts";

const dirs: string[] = [];
afterEach(async () => { hook.onSync = undefined; for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
it("does not delete a successor writer's Git lock after installing its index", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rcmcp-index-lock-")); dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid"); git("config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, "a.txt"), "checkpoint\n");
  let successorLock = "";
  hook.onSync = async (target) => {
    // Deterministically occupy the interval after rename releases index.lock,
    // while the first checkpoint is still awaiting its directory fsync.
    successorLock = target + ".lock";
    await writeFile(successorLock, "successor writer", { flag: "wx" });
  };
  expect(await repoCheckpoint({ path: dir })).toMatchObject({ created: true, indexUpdated: true });
  expect(successorLock).not.toBe("");
  expect(await readFile(successorLock, "utf8")).toBe("successor writer");
});
