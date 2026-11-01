import { expect, it } from "vitest";
import { candidateAsset, quoteArgument } from "../scripts/agent-desktop-monitor.ts";
import { validateArchiveEntries, candidateSchema } from "../scripts/update-agent-desktop.ts";

it("binds a stable release to its exact official archive and digest", () => {
  const release = { tag_name: "v1.0.2", prerelease: false, draft: false, assets: [{ name: "agent-desktop-v1.0.2-x86_64-unknown-linux-gnu.tar.gz", browser_download_url: "https://github.com/vercel-labs/agent-desktop/releases/download/v1.0.2/agent-desktop-v1.0.2-x86_64-unknown-linux-gnu.tar.gz", digest: `sha256:${"a".repeat(64)}` }] };
  expect(candidateAsset(release, false).sha256).toBe("a".repeat(64));
  expect(() => candidateAsset({ ...release, prerelease: true }, false)).toThrow("invalid_stable_release");
  expect(() => candidateAsset({ ...release, assets: [{ ...release.assets[0], browser_download_url: "https://example.invalid/archive" }] }, false)).toThrow("release_asset_unverified");
  expect(() => candidateAsset({ ...release, assets: [{ ...release.assets[0], digest: null }] }, false)).toThrow("release_asset_unverified");
});
it.each(["../agent-desktop", "/tmp/agent-desktop", "nested/agent-desktop", "unknown-helper"])("rejects archive path %s", name => {
  expect(() => validateArchiveEntries([name], ["-rwxr-xr-x file"])).toThrow("unsafe_release_archive");
});
it("rejects symlinks and duplicate archive entries", () => {
  expect(() => validateArchiveEntries(["agent-desktop"], ["lrwxrwxrwx target"])).toThrow();
  expect(() => validateArchiveEntries(["agent-desktop", "agent-desktop"], ["-rwxr-xr-x file"])).toThrow();
  expect(() => validateArchiveEntries(["agent-desktop", "agent-desktop-linux-clipboard-owner"], ["-rwxr-xr-x file", "-rwxr-xr-x file"])).not.toThrow();
});
it("requires provenance verification from the authenticated update controller", () => {
  expect(candidateSchema.safeParse({ version: "1.0.2", url: "https://example.invalid/release", sha256: "a".repeat(64), commit: "b".repeat(40), provenanceVerified: false }).success).toBe(false);
});
it("quotes configured command paths without interpreting shell syntax", () => {
  expect(quoteArgument("a'b$(x)", false)).toBe("'a'\\''b$(x)'");
  expect(quoteArgument("a'b$(x)", true)).toBe("'a''b$(x)'");
});
