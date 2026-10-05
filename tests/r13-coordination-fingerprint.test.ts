import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
import { coordinationToken, ResourceCoordinator } from "../apps/agent/src/coordination.ts";

const gitProbeMutation = vi.hoisted(() => ({ submodule: "", armed: false, mutate: undefined as (() => void) | undefined, suppressDirtyRoot: "" }));
function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
vi.mock("../apps/agent/src/repo.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("../apps/agent/src/repo.ts")>();
  return { ...actual, gitRaw: async (...args: Parameters<typeof actual.gitRaw>) => {
    const result = await actual.gitRaw(...args);
    if (gitProbeMutation.armed && sameNativePath(args[0], gitProbeMutation.submodule)
      && args[1][0] === "status" && args[1].includes("--porcelain=v2")) {
      gitProbeMutation.armed = false;
      gitProbeMutation.mutate?.();
    }
    if (args[0] === gitProbeMutation.suppressDirtyRoot) {
      const command = args[1][0];
      if (command === "status" || (command === "ls-files" && args[1].includes("--modified"))) {
        return { ...result, stdout: "" };
      }
    }
    return result;
  } };
});

function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
function repository(prefix: string) {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, prefix));
  git(root, "init", "-q");
  return root;
}
function commit(root: string, message: string) {
  git(root, "add", ".");
  git(root, "-c", "user.name=Synthetic", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", message);
}

function submoduleFixture(prefix: string) {
  const child = repository(`${prefix}-child-`), file = path.join(child, "tracked.txt");
  writeFileSync(file, "A\n"); commit(child, "child A"); const a = git(child, "rev-parse", "HEAD");
  writeFileSync(file, "B\n"); commit(child, "child B"); const b = git(child, "rev-parse", "HEAD");
  writeFileSync(file, "C\n"); commit(child, "child C"); const c = git(child, "rev-parse", "HEAD");
  const parent = repository(`${prefix}-parent-`);
  git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
  commit(parent, "parent gitlink C");
  return { parent, child, submodule: path.join(parent, "sub"), a, b, c };
}

it("accepts a clean Git repository with more than 4096 tracked files", async () => {
  const root = repository("r13-many-files-");
  for (let group = 0; group < 41; group++) {
    const directory = path.join(root, `group-${group}`); mkdirSync(directory);
    for (let item = 0; item < 100; item++) writeFileSync(path.join(directory, `file-${item}.txt`), "");
  }
  commit(root, "many clean tracked files");
  await expect(resolveCoordinationResource({ kind: "repo", path: root })).resolves.toMatchObject({ baseVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it("accepts clean tracked content larger than 64 MiB", async () => {
  const root = repository("r13-large-content-"), file = path.join(root, "large-synthetic.bin");
  writeFileSync(file, "");
  truncateSync(file, 65 * 1024 * 1024);
  commit(root, "large clean tracked content");
  await expect(resolveCoordinationResource({ kind: "repo", path: root })).resolves.toMatchObject({ baseVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
});

it("changes the Git base for dirty tracked and untracked worktree content", async () => {
  const root = repository("r13-dirty-content-");
  writeFileSync(path.join(root, "tracked.txt"), "before\n"); commit(root, "tracked fixture");
  const clean = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(path.join(root, "tracked.txt"), "after!\n");
  const dirty = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(dirty.baseVersion).not.toBe(clean.baseVersion);
  writeFileSync(path.join(root, "tracked.txt"), "before\n");
  const restored = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(restored.baseVersion).toBe(clean.baseVersion);
  writeFileSync(path.join(root, "untracked.txt"), "synthetic\n");
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(clean.baseVersion);
});

it("changes the Git base for staged-only index content and ref updates", async () => {
  const root = repository("r13-index-ref-");
  const file = path.join(root, "tracked.txt");
  writeFileSync(file, "committed\n"); commit(root, "index and ref fixture");
  const clean = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(file, "staged\n"); git(root, "add", "tracked.txt"); writeFileSync(file, "committed\n");
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(clean.baseVersion);

  const refRoot = repository("r13-ref-only-");
  writeFileSync(path.join(refRoot, "tracked.txt"), "committed\n"); commit(refRoot, "ref-only fixture");
  const beforeRef = await resolveCoordinationResource({ kind: "repo", path: refRoot });
  git(refRoot, "branch", "synthetic-ref");
  expect((await resolveCoordinationResource({ kind: "repo", path: refRoot })).baseVersion).not.toBe(beforeRef.baseVersion);
});

it.runIf(process.platform !== "win32")("detects tracked changes hidden by clean filters and core.filemode", async () => {
  const filtered = repository("r13-clean-filter-");
  git(filtered, "config", "filter.synthetic.clean", "sed s/WORKTREE_A/WORKTREE_B/g");
  writeFileSync(path.join(filtered, ".gitattributes"), "*.txt filter=synthetic\n");
  writeFileSync(path.join(filtered, "tracked.txt"), "WORKTREE_A\n"); commit(filtered, "clean-filter fixture");
  const beforeFilter = await resolveCoordinationResource({ kind: "repo", path: filtered });
  writeFileSync(path.join(filtered, "tracked.txt"), "WORKTREE_B\n");
  expect(git(filtered, "status", "--porcelain=v2", "--untracked-files=all")).toBe("");
  expect(git(filtered, "ls-files", "--modified")).toBe("");
  expect((await resolveCoordinationResource({ kind: "repo", path: filtered })).baseVersion).not.toBe(beforeFilter.baseVersion);

  const modeRoot = repository("r13-hidden-mode-");
  const script = path.join(modeRoot, "run.sh");
  writeFileSync(script, "#!/bin/sh\necho synthetic\n"); chmodSync(script, 0o755); commit(modeRoot, "mode fixture");
  git(modeRoot, "config", "core.filemode", "false");
  const beforeMode = await resolveCoordinationResource({ kind: "repo", path: modeRoot });
  chmodSync(script, 0o644);
  expect(git(modeRoot, "status", "--porcelain=v2", "--untracked-files=all")).toBe("");
  expect(git(modeRoot, "ls-files", "--modified")).toBe("");
  expect((await resolveCoordinationResource({ kind: "repo", path: modeRoot })).baseVersion).not.toBe(beforeMode.baseVersion);
});

it.each(["yes", "on", "1"])("normalizes core.autocrlf=%s before selecting worktree content hashing", async value => {
  const root = repository("r13-autocrlf-bool-"), file = path.join(root, "tracked.txt");
  git(root, "config", "core.autocrlf", value);
  writeFileSync(file, "A\r\nB\n"); commit(root, "autocrlf fixture");
  const before = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(file, "A\nB\r\n");
  // Some Git builds surface this normalization-only byte change as dirty while
  // others normalize it clean. The coordination fingerprint must change either way.
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(before.baseVersion);
});

it("hashes worktree bytes for the legacy crlf attribute even when Git normalizes the edit clean", async () => {
  const root = repository("r13-legacy-crlf-"), file = path.join(root, "tracked.txt");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(path.join(root, ".gitattributes"), "*.txt crlf\n");
  writeFileSync(file, "A\r\nB\n"); commit(root, "legacy crlf fixture");
  const before = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(file, "A\nB\r\n");
  expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe("");
  expect(git(root, "ls-files", "--modified")).toBe("");
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(before.baseVersion);
});

it("hashes tracked bytes when Git is configured for relaxed stat detection", async () => {
  const root = repository("r13-relaxed-stat-"), file = path.join(root, "tracked.txt");
  writeFileSync(file, "before\n"); commit(root, "relaxed stat fixture");
  git(root, "config", "core.trustctime", "false");
  git(root, "config", "core.checkstat", "minimal");
  const before = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(file, "after!\n");
  gitProbeMutation.suppressDirtyRoot = root;
  try {
    expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(before.baseVersion);
  } finally {
    gitProbeMutation.suppressDirtyRoot = "";
  }
});

it.runIf(process.platform !== "win32")("changes the Git base for tracked symlink replacement and deletion", async () => {
  const root = repository("r13-symlink-delete-");
  writeFileSync(path.join(root, "target-a.txt"), "a\n");
  writeFileSync(path.join(root, "target-b.txt"), "b\n");
  const link = path.join(root, "tracked-link");
  symlinkSync("target-a.txt", link); commit(root, "symlink fixture");
  const before = await resolveCoordinationResource({ kind: "repo", path: root });
  unlinkSync(link); symlinkSync("target-b.txt", link);
  const replaced = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(replaced.baseVersion).not.toBe(before.baseVersion);
  unlinkSync(link);
  const deleted = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(deleted.baseVersion).not.toBe(before.baseVersion);
  expect(deleted.baseVersion).not.toBe(replaced.baseVersion);
});

it.each([
  ["assume-unchanged", "--assume-unchanged"],
  ["skip-worktree", "--skip-worktree"],
])("hashes %s tracked content and removal even when Git status suppresses it", async (_label, flag) => {
  const root = repository("r13-hidden-index-"), file = path.join(root, "tracked.txt");
  writeFileSync(file, "before\n"); commit(root, "hidden index fixture");
  git(root, "update-index", flag, "tracked.txt");
  const before = await resolveCoordinationResource({ kind: "repo", path: root });
  writeFileSync(file, "after!\n");
  expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe("");
  expect(git(root, "ls-files", "--modified")).toBe("");
  const changed = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(changed.baseVersion).not.toBe(before.baseVersion);
  unlinkSync(file);
  expect(git(root, "status", "--porcelain=v2", "--untracked-files=all")).toBe("");
  const removed = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(removed.baseVersion).not.toBe(before.baseVersion);
  expect(removed.baseVersion).not.toBe(changed.baseVersion);
});

it("frames each non-Git and Git worktree payload independently", async () => {
  const verify = async (root: string, gitRepository: boolean) => {
    if (gitRepository) git(root, "init", "-q");
    const a = path.join(root, "a"), b = path.join(root, "b");
    writeFileSync(a, "X"); writeFileSync(b, "");
    const oldBoundary = JSON.stringify(["b", String(statSync(b, { bigint: true }).mode & 0o177777n)]);
    writeFileSync(b, `${oldBoundary}Y`);
    const before = await resolveCoordinationResource({ kind: "repo", path: root });
    writeFileSync(a, `X${oldBoundary}`); writeFileSync(b, "Y");
    const redistributed = await resolveCoordinationResource({ kind: "repo", path: root });
    expect(redistributed.baseVersion).not.toBe(before.baseVersion);
    writeFileSync(b, "Z");
    expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(redistributed.baseVersion);
  };
  await verify(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "r13-frame-nongit-")), false);
  await verify(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "r13-frame-git-")), true);
});

it("includes initialized submodule HEAD and dirty state in the Git base", async () => {
  const { parent, submodule, a, b, c } = submoduleFixture("r13-submodule-state");
  expect(git(submodule, "rev-parse", "HEAD")).toBe(c);
  const clean = await resolveCoordinationResource({ kind: "repo", path: parent });
  git(submodule, "checkout", "-q", a);
  const atA = await resolveCoordinationResource({ kind: "repo", path: parent });
  expect(atA.baseVersion).not.toBe(clean.baseVersion);

  const parentStatusA = git(parent, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none");
  git(submodule, "checkout", "-q", b);
  const parentStatusB = git(parent, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none");
  expect(parentStatusB).toBe(parentStatusA);
  const atB = await resolveCoordinationResource({ kind: "repo", path: parent });
  expect(atB.baseVersion).not.toBe(atA.baseVersion);

  git(submodule, "checkout", "-q", c);
  const restored = await resolveCoordinationResource({ kind: "repo", path: parent });
  writeFileSync(path.join(submodule, "tracked.txt"), "D\n");
  const dirty = await resolveCoordinationResource({ kind: "repo", path: parent });
  expect(dirty.baseVersion).not.toBe(restored.baseVersion);
});

it.each([
  ["assume-unchanged", "--assume-unchanged"],
  ["skip-worktree", "--skip-worktree"],
])("probes an initialized %s gitlink instead of rejecting its directory", async (_label, flag) => {
  const { parent, submodule, a } = submoduleFixture("r13-submodule-flagged");
  git(parent, "update-index", flag, "sub");
  const before = await resolveCoordinationResource({ kind: "repo", path: parent });
  git(submodule, "checkout", "-q", a);
  const after = await resolveCoordinationResource({ kind: "repo", path: parent });
  expect(after.baseVersion).not.toBe(before.baseVersion);
});

it("distinguishes missing and uninitialized tracked submodules", async () => {
  const { parent, submodule } = submoduleFixture("r13-submodule-absent");
  rmSync(submodule, { recursive: true, force: true });
  const missing = await resolveCoordinationResource({ kind: "repo", path: parent });
  mkdirSync(submodule);
  const uninitialized = await resolveCoordinationResource({ kind: "repo", path: parent });
  expect(uninitialized.baseVersion).not.toBe(missing.baseVersion);
});

it.runIf(process.platform !== "win32")("fails when a submodule changes between its first and second probe", async () => {
  const { parent, submodule, a, b } = submoduleFixture("r13-submodule-race");
  git(submodule, "checkout", "-q", a);
  gitProbeMutation.submodule = submodule;
  gitProbeMutation.mutate = () => { git(submodule, "checkout", "-q", b); };
  gitProbeMutation.armed = true;
  try {
    await expect(resolveCoordinationResource({ kind: "repo", path: parent })).rejects.toThrow("base_changed_during_probe");
  } finally {
    gitProbeMutation.armed = false;
    gitProbeMutation.mutate = undefined;
    gitProbeMutation.submodule = "";
  }
});

it("fails a changing dirty-file probe and fences a stable post-probe mutation before effects", async () => {
  const root = repository("r13-changing-content-");
  writeFileSync(path.join(root, "tracked.txt"), "base\n"); commit(root, "base fixture");
  const changing = path.join(root, "changing.bin"); writeFileSync(changing, ""); truncateSync(changing, 64 * 1024 * 1024);
  const fd = openSync(changing, "r+"); let value = 0;
  const timer = setInterval(() => { writeSync(fd, Buffer.from([value++ & 1]), 0, 1, 0); }, 1);
  try {
    await expect(resolveCoordinationResource({ kind: "repo", path: root })).rejects.toThrow("base_changed_during_probe");
  } finally { clearInterval(timer); closeSync(fd); }
  const observed = await resolveCoordinationResource({ kind: "repo", path: root });
  const coordinator = new ResourceCoordinator(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "r13-cas-")));
  const token = coordinationToken(coordinator.acquire(observed));
  writeFileSync(path.join(root, "tracked.txt"), "mutated before begin\n");
  const changed = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(() => coordinator.begin(token, changed)).toThrow("base_changed");
  expect(coordinator.inspect(changed).record).toMatchObject({ state: "reserved" });
});

it("reports precise limits for bounded non-Git directory probes", async () => {
  const many = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "r13-nongit-many-"));
  for (let item = 0; item < 4097; item++) writeFileSync(path.join(many, `file-${item}`), "");
  await expect(resolveCoordinationResource({ kind: "repo", path: many })).rejects.toThrow("non_git_base_entry_limit");
  const large = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "r13-nongit-large-")), file = path.join(large, "large.bin");
  writeFileSync(file, ""); truncateSync(file, 65 * 1024 * 1024);
  await expect(resolveCoordinationResource({ kind: "repo", path: large })).rejects.toThrow("non_git_base_content_limit");
});
