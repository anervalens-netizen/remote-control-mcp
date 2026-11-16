import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const releaseManifestName = ".rcmcp-release.json";
export const maxManifestBytes = 8 * 1024 * 1024;
const maxFileBytes = 64 * 1024 * 1024;
const maxReleaseBytes = 512 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

export function safeReleasePath(name: string): boolean {
  return name.length > 0 && name.length <= 1024 && !/[\\\x00:]/.test(name)
    && !path.posix.isAbsolute(name) && name.split("/").every(part => part !== "" && part !== "." && part !== "..")
    && name.split("/")[0] !== ".git" && name !== releaseManifestName;
}

const fileSchema = z.object({
  path: z.string().refine(safeReleasePath),
  kind: z.enum(["tracked_source", "generated_artifact"]),
  mode: z.enum(["100644", "100755", "120000"]),
  bytes: z.number().int().min(0).max(maxFileBytes),
  sha256: digest,
  gitBlob: objectId.optional(),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  source: z.object({
    commit: objectId,
    tree: objectId,
    objectFormat: z.enum(["sha1", "sha256"]),
    verification: z.literal("git_blob_comparison"),
    scope: z.literal("full_git_tree"),
  }).strict(),
  files: z.array(fileSchema).min(1).max(20_000),
}).strict().superRefine((manifest, ctx) => {
  const length = manifest.source.objectFormat === "sha1" ? 40 : 64;
  const paths = new Set<string>();
  let sourceFiles = 0, bytes = 0;
  if (manifest.source.commit.length !== length || manifest.source.tree.length !== length) {
    ctx.addIssue({ code: "custom", message: "Object format mismatch" });
  }
  for (const file of manifest.files) {
    if (paths.has(file.path)) ctx.addIssue({ code: "custom", message: "Duplicate path" });
    paths.add(file.path);
    bytes += file.bytes;
    if (file.kind === "tracked_source") {
      sourceFiles++;
      if (file.gitBlob?.length !== length) ctx.addIssue({ code: "custom", message: "Missing source object ID" });
    } else if (file.gitBlob !== undefined || file.mode === "120000") {
      ctx.addIssue({ code: "custom", message: "Generated artifacts must be regular files without Git provenance" });
    }
  }
  if (sourceFiles === 0 || bytes > maxReleaseBytes) ctx.addIssue({ code: "custom", message: "Invalid release scope or size" });
});

export type ReleaseManifest = z.infer<typeof manifestSchema>;
export type ReleaseFile = ReleaseManifest["files"][number];
export type ReleaseDifference = { path: string; reason: string };
export type ReleaseDiagnostic = {
  manifest: "missing" | "invalid" | "present";
  integrity: "not_checked" | "matched" | "mismatch";
  checkedAt: string;
  verificationScope: "listed_files_at_startup";
  manifestSha256: string | null;
  pin: "not_configured" | "unavailable" | "invalid" | "matched" | "mismatch";
  source: ReleaseManifest["source"] | null;
  provenance: "unavailable" | "unsigned_local_attestation";
  upstreamVerified: false;
  checkedFiles: number;
  declaredFiles: number;
  generatedArtifacts: number;
  differenceCount: number;
  differences: ReleaseDifference[];
  uncovered: readonly string[];
  error?: string;
};
export type RuntimeReleaseIdentity = {
  sha: string | null;
  shaSource: "environment" | "git_checkout" | "configured" | "release_manifest" | "unknown";
  sourceAgreement: "matched" | "mismatch" | "unavailable";
  release: ReleaseDiagnostic;
};

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function gitBlobId(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Pin the physical root; never follow a mutable release-root symlink. */
export function physicalReleaseRoot(directory: string): string {
  const requested = path.resolve(directory), info = lstatSync(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_release_root");
  return realpathSync(requested);
}

/** Symlinks are compared as Git link text, never as the contents of their targets. */
export function readReleaseFile(root: string, name: string, mode: ReleaseFile["mode"], expectedBytes?: number): Buffer {
  if (name !== releaseManifestName && !safeReleasePath(name)) throw new Error("unsafe_relative_path");
  const parts = name.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe_parent");
  }
  const target = path.join(root, ...parts), info = lstatSync(target);
  if (mode === "120000") {
    if (!info.isSymbolicLink()) throw new Error("entry_type_mismatch");
    const bytes = Buffer.from(readlinkSync(target));
    if (bytes.length > maxFileBytes) throw new Error("file_size_limit");
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) throw new Error("content_mismatch");
    return bytes;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("entry_type_mismatch");
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("entry_type_mismatch");
    if (process.platform !== "win32" && Boolean(opened.mode & 0o111) !== (mode === "100755")) throw new Error("executable_mode_mismatch");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0 || opened.size > (name === releaseManifestName ? maxManifestBytes : maxFileBytes)) throw new Error("file_size_limit");
    if (expectedBytes !== undefined && opened.size !== expectedBytes) throw new Error("content_mismatch");
    // The extra byte detects growth without an unbounded readFile allocation.
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== opened.size || fstatSync(fd).size !== opened.size) throw new Error("file_changed_during_read");
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

export function parseReleaseManifest(value: unknown): ReleaseManifest { return manifestSchema.parse(value); }

/** A bounded startup snapshot, not a signature, upstream proof, or continuous integrity monitor. */
export function inspectReleaseManifest(directory: string, expectedManifestSha256?: string): ReleaseDiagnostic {
  const result: ReleaseDiagnostic = {
    manifest: "missing", integrity: "not_checked", checkedAt: new Date().toISOString(),
    verificationScope: "listed_files_at_startup", manifestSha256: null,
    pin: expectedManifestSha256 === undefined ? "not_configured" : "unavailable",
    source: null, provenance: "unavailable", upstreamVerified: false,
    checkedFiles: 0, declaredFiles: 0, generatedArtifacts: 0, differenceCount: 0, differences: [],
    uncovered: ["dependencies", "runtime_binary", "configuration", "unlisted_files", "symlink_targets", "post_start_changes"],
  };
  let root: string;
  try { root = physicalReleaseRoot(directory); }
  catch { return { ...result, manifest: "invalid", error: "unsafe_or_unreadable_release_root" }; }
  let raw: Buffer;
  try { raw = readReleaseFile(root, releaseManifestName, "100644"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    return { ...result, manifest: "invalid", error: "unsafe_or_unreadable_manifest" };
  }
  result.manifestSha256 = sha256(raw);
  if (expectedManifestSha256 !== undefined) {
    result.pin = !/^[a-f0-9]{64}$/.test(expectedManifestSha256) ? "invalid"
      : expectedManifestSha256 === result.manifestSha256 ? "matched" : "mismatch";
  }
  let manifest: ReleaseManifest;
  try { manifest = parseReleaseManifest(JSON.parse(raw.toString("utf8"))); }
  catch { return { ...result, manifest: "invalid", error: "invalid_manifest" }; }
  result.manifest = "present";
  result.source = manifest.source;
  result.provenance = "unsigned_local_attestation";
  result.declaredFiles = manifest.files.length;
  result.generatedArtifacts = manifest.files.filter(file => file.kind === "generated_artifact").length;
  for (const file of manifest.files) {
    let reason: string | undefined;
    try {
      const bytes = readReleaseFile(root, file.path, file.mode, file.bytes);
      result.checkedFiles++;
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) reason = "content_mismatch";
      else if (file.kind === "tracked_source" && gitBlobId(bytes, manifest.source.objectFormat) !== file.gitBlob) reason = "git_blob_mismatch";
    } catch (error) { reason = error instanceof Error && error.message === "content_mismatch" ? "content_mismatch" : "unreadable_or_unsafe_path"; }
    if (reason) {
      result.differenceCount++;
      if (result.differences.length < 20) result.differences.push({ path: file.path, reason });
    }
  }
  result.integrity = result.differenceCount === 0 ? "matched" : "mismatch";
  return result;
}

/** Call once during process initialization. Requests reuse this snapshot. */
export function runtimeReleaseIdentity(directory: string, options: {
  legacySha?: string | null;
  legacySource?: "environment" | "git_checkout" | "configured" | "unknown";
  expectedManifestSha256?: string;
} = {}): RuntimeReleaseIdentity {
  const release = inspectReleaseManifest(directory, options.expectedManifestSha256);
  const sourceAgreement = options.legacySha && release.source
    ? (options.legacySha === release.source.commit ? "matched" : "mismatch") : "unavailable";
  const usableManifest = release.integrity === "matched" && release.pin !== "mismatch" && release.pin !== "invalid";
  // Preserve explicit legacy overrides. For an archive nested inside a checkout,
  // a matching manifest identifies its source more accurately than the parent HEAD.
  const legacySource = options.legacySource ?? (options.legacySha ? "configured" : "unknown");
  const useManifest = usableManifest && legacySource !== "environment" && legacySource !== "configured";
  const sha = useManifest ? release.source!.commit : options.legacySha ?? null;
  return { sha, shaSource: useManifest ? "release_manifest" : sha ? legacySource : "unknown", sourceAgreement, release };
}
