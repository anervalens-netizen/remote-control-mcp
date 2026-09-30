import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { windowsNativePath } from "../apps/agent/src/windows-native-path.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }); });
function ps(script: string, env: Record<string, string>) {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024,
  }).trim();
}

describe.skipIf(process.platform !== "win32")("Windows cross-volume tree compression", () => {
  it.each([
    { compressed: true, longPath: false }, { compressed: false, longPath: false },
    { compressed: true, longPath: true }, { compressed: false, longPath: true },
  ])("preserves directory and file compression across opposite staging defaults (%j)", async ({ compressed, longPath }) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-tree-compression-")); roots.push(root);
    let tree = path.join(root, "initial");
    await fsp.mkdir(path.join(tree, "source"), { recursive: true });
    await fsp.mkdir(path.join(tree, "target"));
    const bytes = Buffer.alloc(65536, 65);
    await fsp.writeFile(path.join(tree, "source", "child.bin"), bytes);
    // Only fixture setup uses compact with ordinary short paths. The real
    // metadata clone receives extended paths and must not invoke compact.
    ps("$ErrorActionPreference='Stop'; & compact.exe $env:SOURCE_ACTION /I /Q $env:SOURCE_DIR $env:SOURCE_FILE | Out-Null; if($LASTEXITCODE -ne 0){throw 'Fixture source compression failed'}; & compact.exe $env:DEST_ACTION /I /Q $env:DEST_PARENT | Out-Null; if($LASTEXITCODE -ne 0){throw 'Fixture destination compression failed'}", {
      SOURCE_ACTION: compressed ? "/C" : "/U", DEST_ACTION: compressed ? "/U" : "/C",
      SOURCE_DIR: path.join(tree, "source"), SOURCE_FILE: path.join(tree, "source", "child.bin"), DEST_PARENT: path.join(tree, "target"),
    });
    if (longPath) {
      const parent = path.join(root, "p".repeat(110)); await fsp.mkdir(parent);
      const moved = path.join(parent, "q".repeat(110)); await fsp.rename(tree, moved); tree = moved;
    }
    const source = path.join(tree, "source"), destination = path.join(tree, "target", "destination");
    if (longPath) expect(source.length).toBeGreaterThan(260);
    const originalRename = fsp.rename;
    let injected = false;
    Object.assign(fsp, { rename: async (...args: Parameters<typeof fsp.rename>) => {
      if (!injected && args[0] === source && args[1] === destination) {
        injected = true;
        throw Object.assign(new Error("Synthetic cross-volume boundary"), { code: "EXDEV" });
      }
      return originalRename(...args);
    } });
    syncBuiltinESMExports();
    try {
      const { movePath } = await import("../apps/agent/src/filesystem-atomic.ts");
      const moved = await movePath(source, destination, true);
      expect(injected).toBe(true);
      expect(moved).toMatchObject({ ok: true, crossDevice: true, sourceRemoved: true });
      expect(await fsp.readFile(path.join(destination, "child.bin"))).toEqual(bytes);
      const flags = JSON.parse(ps("$root=[IO.File]::GetAttributes($env:DEST_ROOT);$file=[IO.File]::GetAttributes($env:DEST_FILE);@{root=(($root -band [IO.FileAttributes]::Compressed)-ne 0);file=(($file -band [IO.FileAttributes]::Compressed)-ne 0)}|ConvertTo-Json -Compress", {
        DEST_ROOT: windowsNativePath(destination), DEST_FILE: windowsNativePath(path.join(destination, "child.bin")),
      }));
      expect(flags).toEqual({ root: compressed, file: compressed });
      await expect(fsp.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      Object.assign(fsp, { rename: originalRename }); syncBuiltinESMExports();
    }
  }, 30000);
});
