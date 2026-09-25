import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { repoCheckpoint, repoApplyPatch } from "../apps/agent/src/repo-edit.ts";
import { fsEdit } from "../apps/agent/src/fs-edit.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const dirs: string[] = [];
function temp() { const d = mkdtempSync(path.join(os.tmpdir(), "rcmcp-edit-")); dirs.push(d); return d; }
function git(d: string, ...args: string[]) { return execFileSync("git", ["-C", d, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
function put(d: string, f: string, data: string | Buffer) { writeFileSync(path.join(d, f), data); }
function read(d: string, f: string) { return readFileSync(path.join(d, f), "utf8"); }
function repo(initial = true) {
  const d = temp(); git(d, "init"); git(d, "config", "user.email", "test@example.invalid");
  git(d, "config", "user.name", "Test"); git(d, "config", "core.autocrlf", "false");
  git(d, "config", "commit.gpgsign", "false");
  if (initial) { put(d, "a.txt", "before\n"); put(d, "b.txt", "before\n"); git(d, "add", "."); git(d, "commit", "-m", "initial"); }
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n";

describe("precise Git checkpoints", () => {
  it("commits selected worktree content and new paths, retaining unrelated partial staging", async () => {
    const d = repo(); put(d, "b.txt", "staged\n"); git(d, "add", "b.txt"); put(d, "b.txt", "unstaged\n");
    put(d, "a.txt", "selected\n"); put(d, "nou ü.txt", "new\n");
    const result = await repoCheckpoint({ path: d, paths: ["a.txt", "nou ü.txt"], message: "selected" });
    expect(result.created).toBe(true); expect(git(d, "show", "HEAD:a.txt")).toBe("selected\n");
    expect(git(d, "show", "HEAD:b.txt")).toBe("before\n"); expect(git(d, "show", ":b.txt")).toBe("staged\n");
    expect(read(d, "b.txt")).toBe("unstaged\n"); expect(git(d, "show", "HEAD:nou ü.txt")).toBe("new\n");
  });
  it("staged-only leaves later worktree changes untouched", async () => {
    const d = repo(); put(d, "a.txt", "staged\n"); git(d, "add", "a.txt"); put(d, "a.txt", "later\n"); put(d, "new.txt", "new");
    await repoCheckpoint({ path: d, mode: "staged" });
    expect(git(d, "show", "HEAD:a.txt")).toBe("staged\n"); expect(read(d, "a.txt")).toBe("later\n");
    expect(git(d, "status", "--porcelain")).toContain("?? new.txt");
  });
  it("preview preserves original index bytes and HEAD including an unborn repository", async () => {
    for (const initial of [true, false]) {
      const d = repo(initial); put(d, "new.txt", "new\n");
      const index = path.join(d, ".git/index"); const original = existsSync(index) ? readFileSync(index) : null;
      const before = initial ? git(d, "rev-parse", "HEAD") : null;
      const result = await repoCheckpoint({ path: d, paths: ["new.txt"], dryRun: true });
      expect(result.created).toBe(false); expect("wouldCreate" in result && result.wouldCreate).toBe(true);
      expect(existsSync(index) ? readFileSync(index) : null).toEqual(original);
      if (initial) expect(git(d, "rev-parse", "HEAD")).toBe(before);
      expect(existsSync(index + ".lock")).toBe(false);
    }
  });
  it("excludes unstaged new files, commits deletions and permits explicit empty checkpoints", async () => {
    const d = repo(); rmSync(path.join(d, "a.txt")); put(d, "new.txt", "new");
    await repoCheckpoint({ path: d, includeUntracked: false });
    expect(git(d, "ls-tree", "--name-only", "HEAD")).not.toContain("a.txt");
    expect(git(d, "status", "--porcelain")).toContain("?? new.txt");
    expect((await repoCheckpoint({ path: d, includeUntracked: false })).created).toBe(false);
    expect((await repoCheckpoint({ path: d, mode: "staged", allowEmpty: true })).created).toBe(true);
  });
  it("restores original staging when a commit hook rejects selected paths", async () => {
    const d = repo(); put(d, "b.txt", "staged\n"); git(d, "add", "b.txt"); put(d, "a.txt", "changed\n");
    const original = readFileSync(path.join(d, ".git/index")); const head = git(d, "rev-parse", "HEAD");
    put(d, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n"); chmodSync(path.join(d, ".git/hooks/pre-commit"), 0o755);
    await expect(repoCheckpoint({ path: d, paths: ["a.txt"] })).rejects.toThrow();
    expect(readFileSync(path.join(d, ".git/index"))).toEqual(original);
    expect(git(d, "rev-parse", "HEAD")).toBe(head); expect(existsSync(path.join(d, ".git/index.lock"))).toBe(false);
  });
  it("retains native all-mode ability to stage a resolved merge and commit its parents", async () => {
    const d = repo();
    git(d, "checkout", "-b", "other"); put(d, "a.txt", "other\n"); git(d, "commit", "-am", "other");
    git(d, "checkout", "-b", "current", "HEAD~1"); put(d, "a.txt", "current\n"); git(d, "commit", "-am", "current");
    expect(() => git(d, "merge", "other")).toThrow();
    put(d, "a.txt", "resolved\n");
    expect((await repoCheckpoint({ path: d })).created).toBe(true);
    expect(git(d, "show", "HEAD:a.txt")).toBe("resolved\n");
    expect(git(d, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
  });
  it("respects a concurrent Git index lock without overwriting it", async () => {
    const d = repo(); put(d, ".git/index.lock", "other operation");
    await expect(repoCheckpoint({ path: d })).rejects.toThrow();
    expect(read(d, ".git/index.lock")).toBe("other operation");
  });
  it("works in a linked worktree and with relative pathspecs from a subdirectory", async () => {
    const d = repo(), linked = path.join(temp(), "linked"); git(d, "worktree", "add", "-b", "feature", linked);
    mkdirSync(path.join(linked, "sub")); put(linked, "sub/new.txt", "new\n"); put(linked, "a.txt", "outside\n");
    const result = await repoCheckpoint({ path: path.join(linked, "sub"), paths: ["new.txt"] });
    expect(result.created).toBe(true); expect(git(linked, "show", "HEAD:sub/new.txt")).toBe("new\n");
    expect(git(linked, "show", "HEAD:a.txt")).toBe("before\n");
  });
  it.runIf(process.platform !== "win32")("handles tabs and newlines in literal filenames", async () => {
    const d = repo(); const name = "odd\tline\n.txt"; put(d, name, "new\n");
    const result = await repoCheckpoint({ path: d, paths: [":(literal)" + name] });
    expect(result.changes).toContainEqual({ status: "A", path: name });
    expect(git(d, "show", "HEAD:" + name)).toBe("new\n");
  });
});

describe("Git patch application", () => {
  it.each(["worktree", "index", "both"] as const)("checks/applies/reverses a patch to %s", async (target) => {
    const d = repo();
    expect(await repoApplyPatch({ path: d, patch, target, checkOnly: true })).toMatchObject({ ok: true, applied: false });
    expect(read(d, "a.txt")).toBe("before\n"); expect(git(d, "show", ":a.txt")).toBe("before\n");
    expect(await repoApplyPatch({ path: d, patch, target })).toMatchObject({ ok: true, applied: true });
    expect(read(d, "a.txt")).toBe(target === "index" ? "before\n" : "after\n");
    expect(git(d, "show", ":a.txt")).toBe(target === "worktree" ? "before\n" : "after\n");
    expect((await repoApplyPatch({ path: d, patch, target, reverse: true })).ok).toBe(true);
    expect(read(d, "a.txt")).toBe("before\n");
  });
  it("returns structured failure for malformed patches (native Git exit128)", async () => {
    const d = repo();
    expect(await repoApplyPatch({ path: d, patch: "garbage" })).toMatchObject({ ok: false, applied: false, exitCode: 128 });
    expect(read(d, "a.txt")).toBe("before\n"); expect(git(d, "status", "--porcelain")).toBe("");
  });
  it("does not apply earlier hunks when another file conflicts", async () => {
    const d = repo(); const second = patch.replaceAll("a.txt", "b.txt").replace("-before", "-not-present");
    expect(await repoApplyPatch({ path: d, patch: patch + second })).toMatchObject({ ok: false, applied: false });
    expect(read(d, "a.txt")).toBe("before\n"); expect(read(d, "b.txt")).toBe("before\n");
  });
  it("applies binary patches and deletions using native Git", async () => {
    const d = repo(); put(d, "bin.dat", Buffer.from([0, 1, 2, 0])); git(d, "add", "."); git(d, "commit", "-m", "binary");
    put(d, "bin.dat", Buffer.from([0, 7, 8, 9, 0])); rmSync(path.join(d, "b.txt")); const binary = git(d, "diff", "--binary");
    git(d, "restore", "."); expect((await repoApplyPatch({ path: d, patch: binary })).ok).toBe(true);
    expect(readFileSync(path.join(d, "bin.dat"))).toEqual(Buffer.from([0, 7, 8, 9, 0])); expect(existsSync(path.join(d, "b.txt"))).toBe(false);
  });
});

describe("verified literal edits", () => {
  it("preserves BOM, CRLF and Unicode with literal dollar replacements and metadata", async () => {
    const d = temp(), file = path.join(d, "file.txt"); put(d, "file.txt", "\uFEFFunu\r\nșase\r\n"); chmodSync(file, 0o640);
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");
    const result = await fsEdit({ path: file, expectedSha256: before, edits: [{ oldText: "unu", newText: "$& doi" }, { oldText: "șase", newText: "七" }] });
    expect(result).toMatchObject({ applied: true, verified: true });
    expect(read(d, "file.txt")).toBe("\uFEFF$& doi\r\n七\r\n");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o640);
  });
  it.runIf(process.platform !== "win32")("edits an owner-readable readonly file while retaining mode 0444", async () => {
    const d = temp(), file = path.join(d, "readonly.txt"); put(d, "readonly.txt", "before");
    chmodSync(file, 0o444);
    expect(await fsEdit({ path: file, edits: [{ oldText: "before", newText: "after" }] })).toMatchObject({ applied: true, verified: true });
    expect(read(d, "readonly.txt")).toBe("after"); expect(statSync(file).mode & 0o777).toBe(0o444);
  });
  it("keeps the whole file intact if any edit is ambiguous/missing or SHA-256 is stale", async () => {
    const d = temp(), file = path.join(d, "a"); put(d, "a", "a a b");
    await expect(fsEdit({ path: file, edits: [{ oldText: "b", newText: "c" }, { oldText: "a", newText: "x" }] })).rejects.toThrow("found 2");
    expect(read(d, "a")).toBe("a a b");
    await expect(fsEdit({ path: file, expectedSha256: "0".repeat(64), edits: [{ oldText: "b", newText: "c" }] })).rejects.toThrow("SHA-256");
    expect(read(d, "a")).toBe("a a b");
    await fsEdit({ path: file, edits: [{ oldText: "a", newText: "x", expectedOccurrences: 2 }] });
    expect(read(d, "a")).toBe("x x b");
  });
  it("supports non-mutating previews and rejects lossy UTF-8 decoding", async () => {
    const d = temp(), file = path.join(d, "a"); put(d, "a", "before");
    expect(await fsEdit({ path: file, dryRun: true, edits: [{ oldText: "before", newText: "after" }] })).toMatchObject({ applied: false, changed: true, dryRun: true });
    expect(read(d, "a")).toBe("before"); put(d, "a", Buffer.from([0xff, 0x61]));
    await expect(fsEdit({ path: file, edits: [{ oldText: "a", newText: "b" }] })).rejects.toThrow("UTF-8");
    expect(readFileSync(file)).toEqual(Buffer.from([0xff, 0x61]));
  });
  it("serializes edits on the same path so concurrent calls preserve both changes", async () => {
    const d = temp(), file = path.join(d, "a"); put(d, "a", "first second");
    await Promise.all([fsEdit({ path: file, edits: [{ oldText: "first", newText: "one" }] }), fsEdit({ path: file, edits: [{ oldText: "second", newText: "two" }] })]);
    expect(read(d, "a")).toBe("one two");
  });
});

it("routes actual SDK tool calls to agent endpoints, validates inputs and surfaces patch failures", async () => {
  const d = repo(), agent = Fastify(); registerExtraRoutes(agent);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  const server = new McpServer({ name: "editing-test", version: "1" });
  registerHighLevelTools(server, new AgentClient([{ name: "pc", url, userUrl: url }]));
  const client = new Client({ name: "test", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const edit = await client.callTool({ name: "fs_edit", arguments: { device: "pc", context: "user", path: path.join(d, "a.txt"), edits: [{ oldText: "before", newText: "after" }] } });
    expect(edit.isError).not.toBe(true); expect(read(d, "a.txt")).toBe("after\n");
    const failure = await client.callTool({ name: "repo_apply_patch", arguments: { device: "pc", path: d, patch } });
    expect(failure.isError).toBe(true);
    const malformed = await agent.inject({ method: "POST", url: "/v1/repo/apply-patch", payload: { path: d, patch: "garbage" } });
    expect(malformed.statusCode).toBe(200); expect(malformed.json()).toMatchObject({ ok: false, applied: false, exitCode: 128 });
    const malformedTool = await client.callTool({ name: "repo_apply_patch", arguments: { device: "pc", path: d, patch: "garbage" } });
    expect(malformedTool.isError).toBe(true);
    const checkpoint = await client.callTool({ name: "repo_checkpoint", arguments: { device: "pc", path: d, paths: ["a.txt"], dryRun: true } });
    expect(checkpoint.isError).not.toBe(true);
    const body = JSON.parse((checkpoint.content as Array<{ text: string }>)[0]!.text);
    expect(body.wouldCreate).toBe(true); expect(body.mode).toBe("paths");
    const invalid = await agent.inject({ method: "POST", url: "/v1/fs/edit", payload: { path: path.join(d, "a.txt"), edits: [{ oldText: "", newText: "x" }] } });
    expect(invalid.statusCode).toBe(400);
  } finally { await client.close(); await server.close(); agent.server.closeAllConnections(); await agent.close(); }
});
