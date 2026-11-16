import { execFileSync } from "node:child_process";
import { lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "./verify-release.ts";
import { gitBlobId, maxManifestBytes, parseReleaseManifest, readReleaseFile, releaseManifestName, safeReleasePath, sha256, type ReleaseFile } from "../packages/shared/src/release-manifest.ts";

/** Full tracked source only; never bless arbitrary installed bytes as Git source. */
export function createReleaseManifest(repository: string, directory: string, commit: string, artifacts: string[] = []) {
  const attestation = verifyRelease(repository, directory, commit);
  if (!attestation.ok) throw new Error(`Source does not match the exact commit (${attestation.differences.length} differences)`);
  const root = attestation.releaseDirectory;
  const git = (...args: string[]) => execFileSync("git", ["-C", path.resolve(repository), ...args], { maxBuffer: 16 * 1024 * 1024 });
  const objectFormat = git("rev-parse", "--show-object-format").toString().trim() as "sha1" | "sha256";
  const files: ReleaseFile[] = [];
  const names = new Set<string>();
  for (const entry of git("ls-tree", "-rz", "--full-tree", attestation.sha).toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), name = entry.slice(tab + 1);
    const [mode, type, gitBlob] = entry.slice(0, tab).split(" ");
    if (tab < 0 || type !== "blob" || !gitBlob || !safeReleasePath(name) || !["100644", "100755", "120000"].includes(mode!)) throw new Error("Unsupported source entry");
    const bytes = readReleaseFile(root, name, mode as ReleaseFile["mode"]);
    // Compare the same bytes we hash into the manifest, not just an earlier read.
    if (gitBlobId(bytes, objectFormat) !== gitBlob) throw new Error("Source changed during manifest generation");
    files.push({ path: name, kind: "tracked_source", mode: mode as ReleaseFile["mode"], bytes: bytes.length, sha256: sha256(bytes), gitBlob });
    names.add(name);
  }
  for (const name of artifacts) {
    if (!safeReleasePath(name) || names.has(name)) throw new Error("Invalid or duplicate generated artifact path");
    const info = lstatSync(path.join(root, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Generated artifact must be a regular file");
    const mode = info.mode & 0o111 ? "100755" : "100644";
    const bytes = readReleaseFile(root, name, mode);
    files.push({ path: name, kind: "generated_artifact", mode, bytes: bytes.length, sha256: sha256(bytes) });
    names.add(name);
  }
  const manifest = parseReleaseManifest({
    version: 1, generatedAt: new Date().toISOString(),
    source: { commit: attestation.sha, tree: attestation.tree, objectFormat, verification: "git_blob_comparison", scope: "full_git_tree" },
    files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  });
  const serialized = JSON.stringify(manifest, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > maxManifestBytes) throw new Error("Manifest size limit exceeded");
  const manifestPath = path.join(root, releaseManifestName);
  // A release is prepared before activation. Refuse replacement of prior evidence.
  writeFileSync(manifestPath, serialized, { flag: "wx", mode: 0o644 });
  return {
    manifestPath, manifestSha256: sha256(Buffer.from(serialized)),
    sha: attestation.sha, tree: attestation.tree, trackedFiles: attestation.checkedFiles,
    generatedArtifacts: artifacts.length, upstreamVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [repository, directory, commit, ...artifacts] = process.argv.slice(2);
    if (!repository || !directory || !commit) throw new Error("Usage: create-release-manifest.ts <repository> <release-directory> <full-commit-id> [generated-artifact-relative-path ...]");
    console.log(JSON.stringify(createReleaseManifest(repository, directory, commit, artifacts), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Manifest generation failed");
    process.exitCode = 1;
  }
}
