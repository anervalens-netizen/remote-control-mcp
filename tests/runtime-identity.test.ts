import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { gitRuntimeSha, runtimeStatus } from "../apps/agent/src/runtime.ts";

function globalSafeDirectories() {
  try {
    return execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

describe("runtime identity SHA", () => {
  it("reads release version and SHA independently of the process working directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-version-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "wrong-working-directory" }));
      const moduleUrl = new URL("../apps/agent/src/runtime.ts", import.meta.url).href;
      const code = `const {runtimeStatus}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(runtimeStatus()));`;
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8" }));
      expect(result.version).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
      expect(result.sha).toBe(gitRuntimeSha());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps runtime status probes off the request hot path", () => {
    const source = readFileSync("apps/agent/src/runtime.ts", "utf8");
    const statusBody = source.slice(source.indexOf("export function runtimeStatus()"));
    expect(statusBody).not.toContain("spawnSync(");
    expect(statusBody).not.toContain("windowsAdmin()");
    expect(statusBody).not.toContain("canElevate(");
    expect(statusBody).not.toContain("probeInteractiveSessionSync(");

    const started = performance.now();
    for (let i = 0; i < 250; i += 1) runtimeStatus();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("resolves the repository SHA with command-local safe.directory and no global mutation", () => {
    const before = globalSafeDirectories();
    const sha = gitRuntimeSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(runtimeStatus().sha).toBe(sha);
    const after = globalSafeDirectories();
    expect(after).toBe(before);
  });
});
