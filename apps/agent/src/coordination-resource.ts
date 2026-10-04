import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import type { CoordinationResource } from "../../../packages/protocol/src/coordination.ts";
import { CoordinationError, coordinationHash, coordinationDevice as device, coordinationIdentity as identity, type ResourceVersion } from "./coordination.ts";
import { gitRaw } from "./repo.ts";
import { serviceManage } from "./system.ts";

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
  if (repository) {
    const head = await gitRaw(root, ["symbolic-ref", "-q", "HEAD"], { allowNonZero: true });
    if (head.code !== 0 && head.code !== 1) throw new CoordinationError("base_probe_failed");
    digest.update(JSON.stringify(head.code === 0 ? ["symbolic-head", head.stdout.trimEnd()] : ["detached-head"]));
    for (const args of [["rev-parse", "--verify", "HEAD"], ["show-ref", "--head"], ...(bare ? [] : [["ls-files", "--stage", "-z"]])]) {
      const result = await gitRaw(root, args, { allowNonZero: true });
      digest.update(JSON.stringify([result.code, result.stdout]));
    }
    if (bare) {
      // Fixed, bounded repository metadata only: refs are captured by show-ref.
      // Never traverse objects, hooks, reflogs, or a nonexistent worktree.
      names = ["HEAD", "config", "packed-refs", "shallow", "info/grafts", "info/attributes"];
    } else {
      const files = await gitRaw(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
      names = [...new Set(files.stdout.split("\0").filter(Boolean))].sort();
    }
  } else {
    // Directory projects without Git: immediate entries/manifests only, explicitly
    // not a recursive snapshot of dependencies or arbitrary command effects.
    names = (await readdir(root)).sort();
  }
  if (names.length > 4096) throw new CoordinationError("base_probe_limit");
  let bytes = 0;
  for (const name of names) {
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) throw new CoordinationError("base_path_invalid");
    const stat = await lstat(file, { bigint: true }).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    digest.update(JSON.stringify([name, stat ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) : null]));
    if (stat?.isSymbolicLink()) digest.update(await readlink(file));
    if (stat?.isFile()) {
      bytes += Number(stat.size); if (bytes > 64 * 1024 * 1024) throw new CoordinationError("base_probe_limit");
      let read = 0;
      for await (const chunk of createReadStream(file)) { read += chunk.length; if (read > Number(stat.size)) throw new CoordinationError("base_changed_during_probe"); digest.update(chunk); }
      const after = await lstat(file, { bigint: true });
      if (after.ino !== stat.ino || after.size !== stat.size || after.ctimeNs !== stat.ctimeNs || after.mtimeNs !== stat.mtimeNs || read !== Number(stat.size)) throw new CoordinationError("base_changed_during_probe");
    }
  }
  return { device, identity, canonicalKey: coordinationHash(["repo", process.platform === "win32" ? common.toLowerCase() : common]), baseVersion: digest.digest("hex") };
}
