import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyRelease } from "../scripts/verify-release.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(algorithm: "sha1" | "sha256" = "sha1") {
  const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-attest-")); roots.push(root);
  const repo = path.join(root, "repository"), release = path.join(root, "release");
  mkdirSync(path.join(repo, "nested"), { recursive: true }); mkdirSync(path.join(release, "nested"), { recursive: true });
  for (const base of [repo, release]) writeFileSync(path.join(base, "nested/source.ts"), "export const fixture = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", `--object-format=${algorithm}`); git("add", "nested/source.ts");
  git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@users.noreply.github.com", "commit", "-qm", "Synthetic release fixture");
  return { root, repo, release, sha: git("rev-parse", "HEAD") };
}
it("attests matching tracked bytes and rejects a modified release", () => {
  const f = fixture();
  expect(verifyRelease(f.repo, f.release, f.sha)).toMatchObject({ ok: true, sha: f.sha, checkedFiles: 1, differences: [] });
  writeFileSync(path.join(f.release, "nested/source.ts"), "changed synthetic content");
  expect(verifyRelease(f.repo, f.release, f.sha)).toMatchObject({ ok: false, differences: [{ path: "nested/source.ts", reason: "content_mismatch" }] });
});
it("rejects a missing release file and mutable or option-shaped commit references", () => {
  const f = fixture(); rmSync(path.join(f.release, "nested/source.ts"));
  expect(verifyRelease(f.repo, f.release, f.sha).ok).toBe(false);
  for (const commit of ["main", "--help", "HEAD", "123"]) expect(() => verifyRelease(f.repo, f.release, commit)).toThrow("immutable full commit");
});
it.skipIf(process.platform === "win32")("refuses a symbolic parent even when external fixture bytes match", () => {
  const f = fixture(); rmSync(path.join(f.release, "nested"), { recursive: true });
  symlinkSync(path.join(f.repo, "nested"), path.join(f.release, "nested"));
  expect(verifyRelease(f.repo, f.release, f.sha)).toMatchObject({ ok: false, differences: [{ path: "nested/source.ts", reason: "unreadable_or_unsafe_path" }] });
});

it("requires the full object ID for the repository's actual hash format", () => {
  const sha256 = fixture("sha256");
  expect(sha256.sha).toHaveLength(64);
  expect(verifyRelease(sha256.repo, sha256.release, sha256.sha)).toMatchObject({ ok: true, sha: sha256.sha });
  expect(() => verifyRelease(sha256.repo, sha256.release, sha256.sha.slice(0, 40))).toThrow("immutable full commit ID");
  const sha1 = fixture("sha1");
  expect(() => verifyRelease(sha1.repo, sha1.release, sha1.sha + "0".repeat(24))).toThrow("immutable full commit ID");
});
it("rejects a symbolic release root even when its target matches every tracked byte", () => {
  const f = fixture(), alias = path.join(f.root, "current");
  symlinkSync(f.release, alias, process.platform === "win32" ? "junction" : "dir");
  expect(() => verifyRelease(f.repo, alias, f.sha)).toThrow("symbolic release root");
});
it("pins physical ancestor aliases in the attestation instead of reporting a mutable alias", () => {
  const f = fixture(), alias = path.join(f.root, "parent-alias");
  symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  expect(verifyRelease(f.repo, path.join(alias, "release"), f.sha)).toMatchObject({ ok: true, releaseDirectory: realpathSync(f.release) });
});
