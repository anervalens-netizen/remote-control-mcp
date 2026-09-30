import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Read-only release attestation. Runtime process identity must be checked separately. */
export function verifyRelease(repository: string, releaseDirectory: string, commit: string) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An immutable full commit ID is required");
  const repositoryPath = path.resolve(repository), requestedRoot = path.resolve(releaseDirectory);
  const git = (...args: string[]) => execFileSync("git", ["-C", repositoryPath, ...args], { maxBuffer: 16 * 1024 * 1024 });
  const algorithm = git("rev-parse", "--show-object-format").toString().trim();
  if (!["sha1", "sha256"].includes(algorithm)) throw new Error("Unsupported repository object format");
  if (commit.length !== (algorithm === "sha1" ? 40 : 64)) throw new Error("An immutable full commit ID matching the repository object format is required");
  const rootInfo = lstatSync(requestedRoot);
  if (rootInfo.isSymbolicLink()) throw new Error("A symbolic release root cannot be attested");
  if (!rootInfo.isDirectory()) throw new Error("The release root must be a directory");
  // Pin and report the physical root even when an ancestor is an alias.
  const root = realpathSync(requestedRoot);
  const sha = git("rev-parse", "--verify", `${commit}^{commit}`).toString().trim();
  if (sha !== commit) throw new Error("The supplied commit does not identify the exact immutable object");
  const tree = git("rev-parse", `${sha}^{tree}`).toString().trim();
  const differences: Array<{ path: string; reason: string }> = [];
  let checkedFiles = 0;
  for (const entry of git("ls-tree", "-rz", "--full-tree", sha).toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), name = entry.slice(tab + 1);
    const [mode, type, expected] = entry.slice(0, tab).split(" ");
    if (tab < 0 || type !== "blob") { differences.push({ path: name, reason: "unsupported_entry" }); continue; }
    const parts = name.split("/"), target = path.resolve(root, ...parts), relative = path.relative(root, target);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Release path escapes its root");
    try {
      let parent = root;
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        if (lstatSync(parent).isSymbolicLink()) throw new Error("symbolic parent");
      }
      const info = lstatSync(target);
      const symbolic = mode === "120000";
      if (symbolic !== info.isSymbolicLink() || (!symbolic && !info.isFile())) {
        differences.push({ path: name, reason: "entry_type_mismatch" }); continue;
      }
      const bytes = symbolic ? Buffer.from(readlinkSync(target)) : readFileSync(target);
      const actual = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      checkedFiles++;
      if (actual !== expected) differences.push({ path: name, reason: "content_mismatch" });
      if (!symbolic && process.platform !== "win32" && Boolean(info.mode & 0o111) !== (mode === "100755")) differences.push({ path: name, reason: "executable_mode_mismatch" });
    } catch { differences.push({ path: name, reason: "unreadable_or_unsafe_path" }); }
  }
  return { version: 1, ok: differences.length === 0 && checkedFiles > 0, sha, tree, releaseDirectory: root, checkedFiles, differences, verifiedAt: new Date().toISOString() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw new Error("Usage: node scripts/verify-release.ts <repository> <release-directory> <full-commit-id>");
    const report = verifyRelease(process.argv[2]!, process.argv[3]!, process.argv[4]!);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) { console.error(error instanceof Error ? error.message : "Release verification failed"); process.exitCode = 2; }
}
