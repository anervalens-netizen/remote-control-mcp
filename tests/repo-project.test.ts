import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { projectPlan } from "../apps/agent/src/project.ts";
import { gitNetworkEnvironment, repoCheckpoint, repoFetch, repoGitPath, repoPull, repoPush, repoSnapshot, resolveRepoSafeDirectory } from "../apps/agent/src/repo.ts";

const dirs: string[] = [];
function temp() { const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "rcmcp-repo-"))); dirs.push(dir); return dir; }
function git(dir: string, ...args: string[]) { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim(); }
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

describe("repository and project high-level primitives", () => {
  it("snapshots and checkpoints a repository", async () => {
    const dir = temp(); git(dir, "init"); git(dir, "config", "user.email", "test@example.invalid"); git(dir, "config", "user.name", "Test");
    writeFileSync(path.join(dir, "a.txt"), "one\n"); git(dir, "add", "a.txt"); git(dir, "commit", "-m", "initial");
    const initial = await repoSnapshot(dir);
    expect(initial.clean).toBe(true);
    expect(statSync(initial.gitDir!).isDirectory()).toBe(true);
    expect(statSync(initial.commonGitDir!).isDirectory()).toBe(true);
    writeFileSync(path.join(dir, "a.txt"), "two\n");
    expect((await repoSnapshot(dir)).clean).toBe(false);
    const checkpoint = await repoCheckpoint({ path: dir, message: "checkpoint test" });
    expect(checkpoint.created).toBe(true);
    expect(git(dir, "log", "-1", "--pretty=%s")).toBe("checkpoint test");
    expect((await repoSnapshot(dir)).clean).toBe(true);
  });

  it("resolves linked-worktree gitdir paths without treating .git as a directory", async () => {
    const main = temp(); git(main, "init"); git(main, "config", "user.email", "test@example.invalid"); git(main, "config", "user.name", "Test");
    writeFileSync(path.join(main, "a.txt"), "one\n"); git(main, "add", "a.txt"); git(main, "commit", "-m", "initial");
    const worktree = temp(); rmSync(worktree, { recursive: true, force: true });
    execFileSync("git", ["-C", main, "worktree", "add", "-b", "worktree-test", worktree], { encoding: "utf8" });
    const dotGit = path.join(worktree, ".git");
    expect(statSync(dotGit).isFile()).toBe(true);
    expect(readFileSync(dotGit, "utf8")).toContain("gitdir:");
    const snapshot = await repoSnapshot(worktree);
    expect(path.normalize(snapshot.root!)).toBe(path.normalize(worktree));
    expect(path.normalize(snapshot.gitDir!)).not.toBe(path.normalize(dotGit));
    expect(statSync(snapshot.gitDir!).isDirectory()).toBe(true);
    const headPath = await repoGitPath(worktree, "HEAD");
    expect(headPath.resolved).toBeTruthy();
    expect(statSync(headPath.resolved!).isFile()).toBe(true);
  });

  it("resolves the exact worktree root from a nested path without Git", async () => {
    const dir = temp(); git(dir, "init");
    const nested = path.join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(path.normalize(await resolveRepoSafeDirectory(nested))).toBe(path.normalize(dir));
  });

  it.skipIf(process.platform === "win32" || typeof process.geteuid !== "function" || process.geteuid() !== 0)(
    "uses exact command-local safe.directory for a different-owner repository",
    async () => {
      const dir = temp();
      git(dir, "init");
      git(dir, "config", "user.email", "test@example.invalid");
      git(dir, "config", "user.name", "Test");
      writeFileSync(path.join(dir, "a.txt"), "one\n");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-m", "initial");
      const nested = path.join(dir, "nested");
      mkdirSync(nested);
      execFileSync("chown", ["-R", "65534:65534", dir]);
      const unsafeGit = () => execFileSync("git", ["-C", nested, "status", "--porcelain"], { encoding: "utf8", stdio: "pipe" });
      expect(unsafeGit).toThrow();
      const snapshot = await repoSnapshot(nested);
      expect(path.normalize(snapshot.root!)).toBe(path.normalize(dir));
      expect(snapshot.clean).toBe(true);
      expect(unsafeGit).toThrow();
    },
  );

  it("creates the first checkpoint in an unborn repository", async () => {
    const dir = temp(); git(dir, "init"); git(dir, "config", "user.email", "test@example.invalid"); git(dir, "config", "user.name", "Test");
    writeFileSync(path.join(dir, "first.txt"), "first\n");
    const checkpoint = await repoCheckpoint({ path: dir, message: "first checkpoint" });
    expect(checkpoint.created).toBe(true);
    expect(checkpoint.before).toBeNull();
    expect(git(dir, "log", "-1", "--pretty=%s")).toBe("first checkpoint");
    expect((await repoSnapshot(dir)).clean).toBe(true);
  });

  it("runs fetch, pull and push non-interactively against a Git remote", async () => {
    const remote = temp();
    git(remote, "init", "--bare");

    const first = temp();
    git(first, "init");
    git(first, "config", "user.email", "test@example.invalid");
    git(first, "config", "user.name", "Test");
    writeFileSync(path.join(first, "a.txt"), "one\n");
    git(first, "add", "a.txt");
    git(first, "commit", "-m", "initial");
    git(first, "remote", "add", "origin", remote);

    const initialPush = await repoPush({
      path: first, remote: "origin", refspecs: ["HEAD:refs/heads/main"], setUpstream: true,
    });
    expect(initialPush).toMatchObject({ ok: true, operation: "push", nonInteractive: true });

    const second = temp();
    rmSync(second, { recursive: true, force: true });
    execFileSync("git", ["clone", "-b", "main", remote, second], { encoding: "utf8" });
    git(second, "config", "user.email", "test@example.invalid");
    git(second, "config", "user.name", "Test");
    writeFileSync(path.join(second, "b.txt"), "two\n");
    git(second, "add", "b.txt");
    git(second, "commit", "-m", "second");
    const secondPush = await repoPush({ path: second });
    expect(secondPush).toMatchObject({ ok: true, operation: "push", nonInteractive: true });

    const fetched = await repoFetch({ path: first, prune: true });
    expect(fetched).toMatchObject({ ok: true, operation: "fetch", nonInteractive: true });
    const pulled = await repoPull({ path: first, remote: "origin", refspecs: ["main"] });
    expect(pulled).toMatchObject({ ok: true, operation: "pull", nonInteractive: true, headChanged: true });
    expect(readFileSync(path.join(first, "b.txt"), "utf8")).toBe("two\n");

    expect(gitNetworkEnvironment()).toMatchObject({
      GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", SSH_ASKPASS_REQUIRE: "never",
    });
  });

  it("fails Git network access non-interactively without leaking URL credentials", async () => {
    const dir = temp();
    git(dir, "init");
    const startedAt = Date.now();
    await expect(repoFetch({
      path: dir,
      remote: "http://owner:super-secret@127.0.0.1:1/repo.git",
      timeoutMs: 1500,
    })).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret");
      expect(message).not.toContain("owner:");
      expect(message).toMatch(/Git fetch (failed|timed out)/);
      return true;
    });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it(process.platform === "win32" ? "reports uncertain Windows Git timeout and bounded repository handle release" : "kills the complete Git process tree before returning a network timeout", async () => {
    const dir = temp();
    git(dir, "init");
    const sockets = new Set<import("node:net").Socket>();
    const hanging = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => { /* taskkill/kill may reset the hanging test socket */ });
      socket.once("close", () => sockets.delete(socket));
      // Accept and intentionally never answer.
    });
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const address = hanging.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      const startedAt = Date.now();
      const failure = await repoFetch({
        path: dir,
        remote: `http://127.0.0.1:${address.port}/repo.git`,
        timeoutMs: 250,
      }).then(() => null, error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain("timed out after 250ms");
      if (process.platform === "win32") {
        expect(failure!.message).toMatch(/termination unverified|descendant termination is not independently verified/);
      }
      expect(Date.now() - startedAt).toBeLessThan(5000);
      if (process.platform === "win32") {
        // Keep the remote hanging during this assertion: closing its sockets
        // first could make a surviving Git descendant exit naturally and mask
        // broken timeout termination. Handle release is not whole-tree proof.
        await expect.poll(() => {
          expect(hanging.listening).toBe(true);
          try { rmSync(dir, { recursive: true, force: true }); return true; }
          catch (error) {
            if (["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
            throw error;
          }
        }, { timeout: 5000, interval: 50 }).toBe(true);
      } else {
        expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
      }
      const index = dirs.indexOf(dir);
      if (index >= 0) dirs.splice(index, 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it("detects package manager and script command", () => {
    const dir = temp();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.29.3", scripts: { check: "echo ok", build: "echo build" } }));
    const plan = projectPlan({ path: dir, action: "check" });
    expect(plan.manager).toBe("pnpm"); expect(plan.command).toBe(process.platform === "win32" ? "& pnpm run check; exit $LASTEXITCODE" : "pnpm run check"); expect(plan.availableScripts).toContain("build");
  });
});
