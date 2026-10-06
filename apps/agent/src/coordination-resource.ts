import { createHash } from "node:crypto";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, realpath, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { CoordinationResource } from "../../../packages/protocol/src/coordination.ts";
import { CoordinationError, coordinationHash, coordinationDevice as device, coordinationIdentity as identity, type ResourceVersion } from "./coordination.ts";
import { gitRaw } from "./repo.ts";
import { serviceManage } from "./system.ts";

type FileSnapshot = { file: string; dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint };
type GitlinkState = { path: string; state: "missing" | "uninitialized" } | {
  path: string; state: "initialized"; head: string; status: string;
};

function sameFileSnapshot(before: FileSnapshot, after: BigIntStats | null): boolean {
  return !!after && after.dev === before.dev && after.ino === before.ino && after.mode === before.mode
    && after.size === before.size && after.ctimeNs === before.ctimeNs && after.mtimeNs === before.mtimeNs;
}

async function probeGitlink(root: string, name: string): Promise<GitlinkState> {
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw new CoordinationError("base_path_invalid");
  const stat = await lstat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!stat) return { path: name, state: "missing" };
  if (!stat.isDirectory()) throw new CoordinationError("git_submodule_worktree_unverifiable");
  const marker = await lstat(path.join(file, ".git"), { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!marker) return { path: name, state: "uninitialized" };

  const top = await gitRaw(file, ["rev-parse", "--show-toplevel"], { allowNonZero: true });
  const superproject = await gitRaw(file, ["rev-parse", "--show-superproject-working-tree"], { allowNonZero: true });
  if (top.code !== 0 || superproject.code !== 0) throw new CoordinationError("git_submodule_worktree_unverifiable");
  const resolvedTop = await realpath(top.stdout.trimEnd()).catch(() => null);
  const resolvedSuperproject = await realpath(superproject.stdout.trimEnd()).catch(() => null);
  const resolvedFile = await realpath(file).catch(() => null);
  if (!resolvedTop || !resolvedSuperproject || !resolvedFile || resolvedTop !== resolvedFile || resolvedSuperproject !== root) {
    throw new CoordinationError("git_submodule_worktree_unverifiable");
  }
  const head = await gitRaw(file, ["rev-parse", "--verify", "HEAD"], { allowNonZero: true });
  if (head.code !== 0) throw new CoordinationError("git_submodule_worktree_unverifiable");
  const status = await gitRaw(file, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  return { path: name, state: "initialized", head: head.stdout, status: status.stdout };
}

export function serviceCanonicalKey(name: string, scope: "user" | "system" | undefined, callerIdentity: string, platform: NodeJS.Platform = process.platform): string {
  const effectiveScope = platform === "win32" ? "system" : scope ?? "system";
  return coordinationHash(["service", effectiveScope, effectiveScope === "user" ? callerIdentity : null, platform === "win32" ? name.toLowerCase() : name]);
}

/** Only hashes enter the coordination journal. No commands, paths, patches, or status output. */
export async function resolveCoordinationResource(input: CoordinationResource): Promise<ResourceVersion> {
  if (input.kind === "service") {
    const status = await serviceManage({ name: input.name, scope: input.scope, action: "status" }) as Record<string, unknown>;
    const name = process.platform === "win32" ? status.Name : status.Id;
    if (typeof name !== "string" || !name || name.length > 256) throw new CoordinationError("service_identity_unavailable");
    return { device, identity, canonicalKey: serviceCanonicalKey(name, input.scope, identity),
      baseVersion: coordinationHash(status) };
  }
  let root = await realpath(input.path), repository = false, bare = false;
  const top = await gitRaw(root, ["rev-parse", "--show-toplevel"], { allowNonZero: true });
  if (top.code === 0) { root = await realpath(top.stdout.trimEnd()); repository = true; }
  else {
    const bareProbe = await gitRaw(root, ["rev-parse", "--is-bare-repository"], { allowNonZero: true });
    bare = bareProbe.code === 0 && bareProbe.stdout.trim() === "true";
    repository = bare;
  }
  const common = repository ? await realpath((await gitRaw(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trimEnd()) : root;
  if (bare) root = common;
  const digest = createHash("sha256").update(root);
  let names: string[];
  let gitWorktreeState: string | undefined;
  const trackedPaths = new Set<string>();
  const gitlinkPaths = new Set<string>();
  const contentHashedPaths = new Set<string>();
  const flaggedTrackedPaths = new Set<string>();
  const gitAuthority: Array<{ args: string[]; code: number; stdout?: string; stdoutHash?: string; stdin?: string }> = [];
  if (repository) {
    const head = await gitRaw(root, ["symbolic-ref", "-q", "HEAD"], { allowNonZero: true });
    if (head.code !== 0 && head.code !== 1) throw new CoordinationError("base_probe_failed");
    gitAuthority.push({ args: ["symbolic-ref", "-q", "HEAD"], code: head.code, stdout: head.stdout });
    digest.update(JSON.stringify(head.code === 0 ? ["symbolic-head", head.stdout.trimEnd()] : ["detached-head"]));
    for (const args of [["rev-parse", "--verify", "HEAD"], ["show-ref", "--head"]]) {
      const result = await gitRaw(root, args, { allowNonZero: true });
      gitAuthority.push({ args, code: result.code, stdout: result.stdout });
      digest.update(JSON.stringify([result.code, result.stdout]));
    }
    if (bare) {
      // Fixed, bounded repository metadata only: refs are captured by show-ref.
      // Never traverse objects, hooks, reflogs, or a nonexistent worktree.
      names = ["HEAD", "config", "packed-refs", "shallow", "info/grafts", "info/attributes"];
    } else {
      // The index is authoritative for clean tracked content. Only dirty tracked
      // and untracked paths need worktree bytes; this keeps ordinary large clean
      // repositories out of the non-Git directory probe limits.
      const statusArgs = ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"];
      gitWorktreeState = (await gitRaw(root, statusArgs)).stdout;
      digest.update(JSON.stringify(["worktree", gitWorktreeState]));
      // Status and --modified intentionally trust assume-unchanged and
      // skip-worktree bits. Capture staged content and flags in one authority
      // pass, then enumerate only exceptional paths for worktree hashing.
      const indexArgs = ["ls-files", "--stage", "-v", "-z"];
      const index = await gitRaw(root, indexArgs);
      gitAuthority.push({ args: indexArgs, code: index.code, stdout: index.stdout });
      digest.update(JSON.stringify(["index", index.code, index.stdout]));
      for (const entry of index.stdout.split("\0").filter(Boolean)) {
        const separator = entry.indexOf("\t");
        if (entry.length < 4 || entry[1] !== " " || separator < 0) throw new CoordinationError("git_index_flags_unparseable");
        const tag = entry[0]!, trackedPath = entry.slice(separator + 1);
        const indexFields = entry.slice(2, separator).split(" ");
        if (indexFields.length !== 3) throw new CoordinationError("git_index_flags_unparseable");
        trackedPaths.add(trackedPath);
        if (indexFields[0] === "160000") gitlinkPaths.add(trackedPath);
        if (tag === "S" || tag === tag.toLowerCase() && tag !== tag.toUpperCase()) flaggedTrackedPaths.add(trackedPath);
      }
      const attributeArgs = ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding", "ident", "text", "eol", "crlf"];
      // Six output records repeat every pathname. Bound input bytes as well as
      // path count so a large clean index cannot overflow gitRaw's stdout cap.
      const attributeBatches: string[] = [];
      let batch = "", batchBytes = 0;
      for (const trackedPath of trackedPaths) {
        const entry = trackedPath + "\0", entryBytes = Buffer.byteLength(entry);
        if (batch && batchBytes + entryBytes > 64 * 1024) {
          attributeBatches.push(batch); batch = ""; batchBytes = 0;
        }
        batch += entry; batchBytes += entryBytes;
      }
      if (batch) attributeBatches.push(batch);
      for (const trackedInput of attributeBatches) {
        const attributes = await gitRaw(root, attributeArgs, { stdin: trackedInput });
        gitAuthority.push({ args: attributeArgs, code: attributes.code, stdoutHash: createHash("sha256").update(attributes.stdout).digest("hex"), stdin: trackedInput });
        digest.update(JSON.stringify(["worktree-attributes", attributes.code, attributes.stdout]));
        const fields = attributes.stdout.split("\0");
        if (fields.at(-1) === "") fields.pop();
        if (fields.length % 3 !== 0) throw new CoordinationError("git_attributes_unparseable");
        for (let index = 0; index < fields.length; index += 3) {
          const [trackedPath, _attribute, value] = fields.slice(index, index + 3) as [string, string, string];
          if (value !== "unspecified" && value !== "unset") contentHashedPaths.add(trackedPath);
        }
      }
      const readConfig = async (key: string) => {
        const args = ["config", "--get", key];
        const result = await gitRaw(root, args, { allowNonZero: true });
        gitAuthority.push({ args, code: result.code, stdout: result.stdout });
        digest.update(JSON.stringify([key, result.code, result.stdout]));
        return result.stdout.trim().toLowerCase();
      };
      const autocrlf = await readConfig("core.autocrlf");
      const gitTrue = new Set(["true", "yes", "on", "1"]);
      const gitFalse = new Set(["false", "no", "off", "0", ""]);
      if (gitTrue.has(autocrlf) || autocrlf === "input") {
        for (const trackedPath of trackedPaths) contentHashedPaths.add(trackedPath);
      }
      const trustctime = await readConfig("core.trustctime");
      const checkstat = await readConfig("core.checkstat");
      const ignorestat = await readConfig("core.ignorestat");
      const fsmonitor = await readConfig("core.fsmonitor");
      const relaxedStatDetection =
        (trustctime !== "" && gitFalse.has(trustctime))
        || checkstat === "minimal"
        || gitTrue.has(ignorestat)
        || (fsmonitor !== "" && !gitFalse.has(fsmonitor));
      if (relaxedStatDetection) {
        for (const trackedPath of trackedPaths) contentHashedPaths.add(trackedPath);
      }
      const files = await gitRaw(root, ["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"]);
      for (const file of [...files.stdout.split("\0").filter(Boolean), ...flaggedTrackedPaths]) contentHashedPaths.add(file);
      // Every tracked path contributes filesystem metadata, even when Git's
      // clean filters or core.filemode settings suppress a real worktree change.
      // Only exceptional paths contribute bytes, so large clean files stay cheap.
      names = [...new Set([...trackedPaths, ...contentHashedPaths])].sort();
    }
  } else {
    // Directory projects without Git: immediate entries/manifests only, explicitly
    // not a recursive snapshot of dependencies or arbitrary command effects.
    names = (await readdir(root)).sort();
  }
  if (!repository && names.length > 4096) throw new CoordinationError("non_git_base_entry_limit");
  const gitlinkStates = new Map<string, GitlinkState>();
  for (const name of [...gitlinkPaths].sort()) {
    const state = await probeGitlink(root, name);
    gitlinkStates.set(name, state);
    digest.update(JSON.stringify(["gitlink-worktree-v1", state]));
  }
  let bytes = 0n;
  const snapshots: FileSnapshot[] = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new CoordinationError("base_path_invalid");
    const stat = await lstat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (stat && flaggedTrackedPaths.has(name) && !gitlinkPaths.has(name) && !stat.isFile() && !stat.isSymbolicLink()) {
      throw new CoordinationError("git_flagged_path_type_unsupported");
    }
    let type = "missing", contentHash: string | null = null;
    if (stat?.isFile()) type = "file";
    else if (stat?.isSymbolicLink()) type = "symlink";
    else if (stat?.isDirectory()) type = "directory";
    else if (stat) type = "other";
    if (stat?.isSymbolicLink()) {
      const target = await readlink(file, { encoding: "buffer" });
      contentHash = createHash("sha256").update(target).digest("hex");
    }
    if (stat?.isFile() && (!repository || bare || contentHashedPaths.has(name))) {
      bytes += stat.size;
      if (!repository && bytes > 64n * 1024n * 1024n) throw new CoordinationError("non_git_base_content_limit");
      let read = 0n;
      const payload = createHash("sha256");
      for await (const chunk of createReadStream(file)) {
        read += BigInt(chunk.length);
        if (read > stat.size) throw new CoordinationError("base_changed_during_probe");
        payload.update(chunk);
      }
      if (read !== stat.size) throw new CoordinationError("base_changed_during_probe");
      contentHash = payload.digest("hex");
    }
    if (stat) {
      const after = await lstat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      const snapshot = { file, dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
      if (!sameFileSnapshot(snapshot, after)) throw new CoordinationError("base_changed_during_probe");
      snapshots.push({ file, dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
    }
    // Each entry is one domain-separated structured record. Payload bytes never
    // enter the aggregate digest directly, so adjacent files cannot share a
    // content/metadata boundary. Volatile inode/timestamps remain probe checks.
    digest.update(JSON.stringify(["path-entry-v2", {
      path: name, type, size: stat ? String(stat.size) : null,
      contentHash, mode: stat ? String(stat.mode & 0o177777n) : null,
    }]));
  }
  if (gitWorktreeState !== undefined) {
    const after = (await gitRaw(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"])).stdout;
    if (after !== gitWorktreeState) throw new CoordinationError("base_changed_during_probe");
  }
  for (const authority of gitAuthority) {
    const after = await gitRaw(root, authority.args, { allowNonZero: true, ...(authority.stdin !== undefined ? { stdin: authority.stdin } : {}) });
    if (after.code !== authority.code || (authority.stdoutHash === undefined ? after.stdout !== authority.stdout : createHash("sha256").update(after.stdout).digest("hex") !== authority.stdoutHash)) throw new CoordinationError("base_changed_during_probe");
  }
  for (const snapshot of snapshots) {
    const after = await lstat(snapshot.file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!sameFileSnapshot(snapshot, after)) throw new CoordinationError("base_changed_during_probe");
  }
  for (const [name, before] of gitlinkStates) {
    const after = await probeGitlink(root, name);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new CoordinationError("base_changed_during_probe");
  }
  return { device, identity, canonicalKey: coordinationHash(["repo", process.platform === "win32" ? common.toLowerCase() : common]), baseVersion: digest.digest("hex") };
}
