import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createReleaseManifest } from "../scripts/create-release-manifest.ts";
import { inspectReleaseManifest, releaseManifestName, runtimeReleaseIdentity, type ReleaseManifest } from "../packages/shared/src/release-manifest.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(algorithm: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-manifest-")); roots.push(root);
  const repo = path.join(root, "repository"), release = path.join(root, "release");
  for (const base of [repo, release]) {
    mkdirSync(path.join(base, "nested"), { recursive: true });
    writeFileSync(path.join(base, "nested/source.ts"), "export const fixture = 1;\n");
    writeFileSync(path.join(base, "package.json"), '{"name":"synthetic-release","version":"1.0.0"}\n');
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", `--object-format=${algorithm}`); git("add", ".");
  git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@users.noreply.github.com", "commit", "-qm", "Synthetic release fixture");
  return { root, repo, release, sha: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}
function editManifest(release: string, edit: (manifest: ReleaseManifest) => void) {
  const target = path.join(release, releaseManifestName);
  const manifest = JSON.parse(readFileSync(target, "utf8")) as ReleaseManifest;
  edit(manifest); writeFileSync(target, JSON.stringify(manifest));
}

it.each(["sha1", "sha256"] as const)("identifies a full %s archive without Git metadata while reporting unsigned provenance", algorithm => {
  const f = fixture(algorithm), receipt = createReleaseManifest(f.repo, f.release, f.sha);
  expect(receipt).toMatchObject({ sha: f.sha, tree: f.tree, trackedFiles: 2, generatedArtifacts: 0, upstreamVerified: false });
  expect(runtimeReleaseIdentity(f.release, { expectedManifestSha256: receipt.manifestSha256 })).toMatchObject({
    sha: f.sha, shaSource: "release_manifest", shaBinding: "pinned_manifest", declaredSourceAgreement: "unavailable", sourceAgreement: "unavailable",
    release: { manifest: "present", validation: "pinned_integrity", integrity: "matched", pin: "matched", checkedFiles: 2, differenceCount: 0,
      source: { commit: f.sha, tree: f.tree, objectFormat: algorithm, scope: "full_git_tree" },
      sourceClaim: "manifest_declaration", provenance: "unsigned_local_attestation", upstreamVerified: false, verificationScope: "listed_files_at_startup" },
  });
});

it("refuses unknown, partial or modified source and does not replace prior evidence", () => {
  const f = fixture();
  expect(() => createReleaseManifest(f.repo, f.release, "HEAD")).toThrow("immutable full commit");
  writeFileSync(path.join(f.release, "nested/source.ts"), "unverified installed bytes");
  expect(() => createReleaseManifest(f.repo, f.release, f.sha)).toThrow("Source does not match");
  expect(inspectReleaseManifest(f.release).manifest).toBe("missing");
  rmSync(path.join(f.release, "nested/source.ts"));
  expect(() => createReleaseManifest(f.repo, f.release, f.sha)).toThrow("Source does not match");
  writeFileSync(path.join(f.release, "nested/source.ts"), readFileSync(path.join(f.repo, "nested/source.ts")));
  const receipt = createReleaseManifest(f.repo, f.release, f.sha);
  const original = readFileSync(receipt.manifestPath, "utf8");
  expect(() => createReleaseManifest(f.repo, f.release, f.sha)).toThrow();
  expect(readFileSync(receipt.manifestPath, "utf8")).toBe(original);
});

it("hashes generated artifacts as separate local snapshots and detects source and artifact drift", () => {
  const f = fixture();
  mkdirSync(path.join(f.release, "dist")); writeFileSync(path.join(f.release, "dist/asset.txt"), "synthetic built output");
  createReleaseManifest(f.repo, f.release, f.sha, ["dist/asset.txt"]);
  const initial = inspectReleaseManifest(f.release);
  expect(initial).toMatchObject({ integrity: "matched", checkedFiles: 3, generatedArtifacts: 1 });
  expect(initial.uncovered).toContain("dependencies"); expect(initial.uncovered).toContain("post_start_changes");
  const manifest = JSON.parse(readFileSync(path.join(f.release, releaseManifestName), "utf8")) as ReleaseManifest;
  expect(manifest.files.find(file => file.path === "dist/asset.txt")).toMatchObject({ kind: "generated_artifact" });
  expect(manifest.files.find(file => file.path === "dist/asset.txt")).not.toHaveProperty("gitBlob");
  writeFileSync(path.join(f.release, "dist/asset.txt"), "changed generated output");
  writeFileSync(path.join(f.release, "nested/source.ts"), "changed source");
  expect(inspectReleaseManifest(f.release)).toMatchObject({ integrity: "mismatch", differenceCount: 2, differences: [
    { path: "dist/asset.txt", reason: "content_mismatch" }, { path: "nested/source.ts", reason: "content_mismatch" },
  ] });
  expect(runtimeReleaseIdentity(f.release).sha).toBeNull();
});

it("keeps environment metadata, manifest pin and local byte integrity distinct", () => {
  const f = fixture(), receipt = createReleaseManifest(f.repo, f.release, f.sha);
  const configuredSha = "0".repeat(40);
  expect(runtimeReleaseIdentity(f.release, { legacySha: configuredSha })).toMatchObject({
    sha: configuredSha, shaSource: "configured", shaBinding: "legacy_declaration", declaredSourceAgreement: "mismatch", sourceAgreement: "unavailable",
  });
  expect(runtimeReleaseIdentity(f.release, { legacySha: configuredSha, legacySource: "environment" })).toMatchObject({
    sha: configuredSha, shaSource: "environment", shaBinding: "legacy_declaration", declaredSourceAgreement: "mismatch", sourceAgreement: "unavailable",
    release: { validation: "integrity_only", integrity: "matched", pin: "not_configured", upstreamVerified: false },
  });
  expect(runtimeReleaseIdentity(f.release, { expectedManifestSha256: "0".repeat(64) })).toMatchObject({
    sha: null, shaSource: "unknown", shaBinding: "unavailable", release: { validation: "rejected", integrity: "matched", pin: "mismatch" },
  });
  expect(inspectReleaseManifest(f.release, "not-a-digest")).toMatchObject({ manifest: "present", validation: "rejected", integrity: "matched", pin: "invalid" });
  expect(runtimeReleaseIdentity(f.release, { legacySha: configuredSha, legacySource: "git_checkout" })).toMatchObject({
    sha: configuredSha, shaSource: "git_checkout", shaBinding: "legacy_declaration", declaredSourceAgreement: "mismatch", sourceAgreement: "unavailable",
  });
  expect(runtimeReleaseIdentity(f.release, { legacySha: configuredSha, legacySource: "git_checkout", expectedManifestSha256: receipt.manifestSha256 })).toMatchObject({
    sha: f.sha, shaSource: "release_manifest", shaBinding: "pinned_manifest", declaredSourceAgreement: "mismatch", sourceAgreement: "mismatch",
  });
  expect(runtimeReleaseIdentity(f.release, { legacySha: configuredSha, legacySource: "environment", expectedManifestSha256: receipt.manifestSha256 })).toMatchObject({
    sha: configuredSha, shaSource: "environment", shaBinding: "legacy_declaration", declaredSourceAgreement: "mismatch", sourceAgreement: "mismatch",
    release: { validation: "pinned_integrity", upstreamVerified: false },
  });
});

it("does not qualify equal source declarations after a listed file changes, even with a matching pin", () => {
  const f = fixture(), receipt = createReleaseManifest(f.repo, f.release, f.sha);
  const options = { legacySha: f.sha, legacySource: "environment" as const, expectedManifestSha256: receipt.manifestSha256 };
  expect(runtimeReleaseIdentity(f.release, options)).toMatchObject({
    sha: f.sha, sourceAgreement: "matched", release: { integrity: "matched", pin: "matched" },
  });
  writeFileSync(path.join(f.release, "nested/source.ts"), "changed installed source");
  expect(runtimeReleaseIdentity(f.release, options)).toMatchObject({
    sha: f.sha, shaSource: "environment", shaBinding: "legacy_declaration", declaredSourceAgreement: "matched", sourceAgreement: "unavailable",
    release: { validation: "rejected", integrity: "mismatch", pin: "matched", sourceClaim: "manifest_declaration", upstreamVerified: false },
  });
});

it("does not use an unpinned manifest's fabricated commit or omitted-file claim as runtime identity", () => {
  const f = fixture(), receipt = createReleaseManifest(f.repo, f.release, f.sha);
  writeFileSync(path.join(f.release, "nested/source.ts"), "changed and omitted");
  editManifest(f.release, manifest => {
    manifest.files = manifest.files.filter(file => file.path !== "nested/source.ts");
    manifest.source.commit = "d".repeat(40); manifest.source.tree = "e".repeat(40);
  });
  expect(runtimeReleaseIdentity(f.release)).toMatchObject({
    sha: null, shaSource: "unknown", shaBinding: "unavailable", sourceAgreement: "unavailable",
    release: { validation: "integrity_only", integrity: "matched", pin: "not_configured", declaredFiles: 1,
      source: { commit: "d".repeat(40), scope: "full_git_tree", verification: "git_blob_comparison" },
      sourceClaim: "manifest_declaration", provenance: "unsigned_local_attestation", upstreamVerified: false },
  });
  expect(runtimeReleaseIdentity(f.release, { expectedManifestSha256: receipt.manifestSha256 })).toMatchObject({
    sha: null, shaBinding: "unavailable", release: { validation: "rejected", integrity: "matched", pin: "mismatch" },
  });
});

it("rejects the composite verdict for a failed pin while retaining the independent matching-byte fact", () => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  expect(inspectReleaseManifest(f.release, "0".repeat(64))).toMatchObject({
    validation: "rejected", integrity: "matched", pin: "mismatch", sourceClaim: "manifest_declaration", upstreamVerified: false,
  });
});

it("reports missing and invalid manifests even when a legacy SHA is configured", () => {
  const f = fixture();
  expect(runtimeReleaseIdentity(f.release, { legacySha: f.sha, legacySource: "environment" })).toMatchObject({
    sha: f.sha, shaSource: "environment", shaBinding: "legacy_declaration", declaredSourceAgreement: "unavailable", sourceAgreement: "unavailable",
    release: { manifest: "missing", validation: "unavailable", integrity: "not_checked", source: null, sourceClaim: "unavailable", provenance: "unavailable" },
  });
  writeFileSync(path.join(f.release, releaseManifestName), "{broken-json");
  expect(inspectReleaseManifest(f.release)).toMatchObject({ manifest: "invalid", validation: "rejected", integrity: "not_checked", error: "invalid_manifest" });
});

it.each(["../outside", "/absolute", "folder/../../escape", "folder\\escape", "C:/escape", ".git/config", releaseManifestName])("rejects an unsafe manifest path %s before verification", unsafePath => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  editManifest(f.release, manifest => { manifest.files[0]!.path = unsafePath; });
  expect(inspectReleaseManifest(f.release)).toMatchObject({ manifest: "invalid", integrity: "not_checked", checkedFiles: 0 });
});

it("rejects duplicates and detects a manifest's incorrect Git blob claim", () => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  editManifest(f.release, manifest => { manifest.files[0]!.gitBlob = "0".repeat(40); });
  expect(inspectReleaseManifest(f.release)).toMatchObject({ manifest: "present", integrity: "mismatch", differences: [{ reason: "git_blob_mismatch" }] });
  editManifest(f.release, manifest => { manifest.files.push(manifest.files[0]!); });
  expect(inspectReleaseManifest(f.release).manifest).toBe("invalid");
});

it.skipIf(process.platform === "win32")("rejects a symbolic root, symbolic parent and executable mode drift", () => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  const alias = path.join(f.root, "current"); symlinkSync(f.release, alias);
  expect(inspectReleaseManifest(alias)).toMatchObject({ manifest: "invalid", error: "unsafe_or_unreadable_release_root" });
  chmodSync(path.join(f.release, "nested/source.ts"), 0o755);
  expect(inspectReleaseManifest(f.release).integrity).toBe("mismatch");
  rmSync(path.join(f.release, "nested"), { recursive: true });
  symlinkSync(path.join(f.repo, "nested"), path.join(f.release, "nested"));
  expect(inspectReleaseManifest(f.release)).toMatchObject({ integrity: "mismatch", differences: [{ path: "nested/source.ts", reason: "unreadable_or_unsafe_path" }] });
});

it("retains a startup snapshot without claiming later filesystem changes are monitored", () => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  const startup = runtimeReleaseIdentity(f.release);
  writeFileSync(path.join(f.release, "nested/source.ts"), "changed after process start");
  expect(startup.release).toMatchObject({ integrity: "matched", verificationScope: "listed_files_at_startup" });
  expect(startup.release.uncovered).toContain("post_start_changes");
  expect(runtimeReleaseIdentity(f.release).release.integrity).toBe("mismatch");
});

it("provides a bounded receipt through the release-builder CLI", () => {
  const f = fixture();
  const output = execFileSync(process.execPath, ["scripts/create-release-manifest.ts", f.repo, f.release, f.sha], { encoding: "utf8" });
  expect(JSON.parse(output)).toMatchObject({ sha: f.sha, trackedFiles: 2, generatedArtifacts: 0, upstreamVerified: false });
  expect(inspectReleaseManifest(f.release).integrity).toBe("matched");
});

it("rejects oversized installed content without trusting a manifest's small byte count", () => {
  const f = fixture(); createReleaseManifest(f.repo, f.release, f.sha);
  truncateSync(path.join(f.release, "nested/source.ts"), 65 * 1024 * 1024);
  expect(inspectReleaseManifest(f.release)).toMatchObject({ integrity: "mismatch", checkedFiles: 1, differenceCount: 1 });
});
