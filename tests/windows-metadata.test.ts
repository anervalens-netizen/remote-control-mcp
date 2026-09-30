import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { fsWrite } from "../apps/agent/src/filesystem.ts";
import { replaceByRename } from "../apps/agent/src/filesystem-atomic.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function ps(script: string, extraEnv: Record<string, string> = {}) {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, ...extraEnv },
  }).trim();
}

describe.skipIf(process.platform !== "win32")("Windows metadata recovery", () => {
  it("uses native no-replace move semantics when force=false", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-win-no-replace-"));
    roots.push(root);
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "SOURCE");
    await writeFile(destination, "EXISTING");

    await expect(replaceByRename(source, destination, false)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await (await import("node:fs/promises")).readFile(source, "utf8")).toBe("SOURCE");
    expect(await (await import("node:fs/promises")).readFile(destination, "utf8")).toBe("EXISTING");
  });

  it("preserves an explicit DACL on atomic rewrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-win-acl-"));
    roots.push(root);
    const file = path.join(root, "acl.txt");
    await writeFile(file, "old");
    const apply = [
      "$p=$env:RCMCP_TEST_PATH",
      "$a=Get-Acl -LiteralPath $p",
      "$r=New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME,'ReadData','Deny')",
      "[void]$a.AddAccessRule($r)",
      "Set-Acl -LiteralPath $p -AclObject $a",
      "(Get-Acl -LiteralPath $p).Sddl",
    ].join(";");
    const before = ps(apply, { RCMCP_TEST_PATH: file });
    const result = await fsWrite({ path: file, data: "new" });
    const after = ps("(Get-Acl -LiteralPath $env:RCMCP_TEST_PATH).Sddl", { RCMCP_TEST_PATH: file });
    expect(result).toMatchObject({ metadataPreserved: true, metadataStrategy: "windows-full", replacedExisting: true });
    // Native descriptor application may clear AUTO_INHERITED bookkeeping.
    // Owner/group, protection, ACE order, rights and deny flags stay exact.
    const semantic = (sddl: string) => sddl.replace(/(D:P?)AI(?=\(|S:|$)/g, "$1");
    expect(semantic(after)).toBe(semantic(before));
  });

  it.each([false, true])("preserves alternate streams, file attributes and NTFS compression on staged rewrite (long=%s)", async longPath => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-win-full-meta-"));
    roots.push(root);
    let file = path.join(root, "full.txt");
    await writeFile(file, "old");
    ps([
      "$p=$env:RCMCP_TEST_PATH",
      "Set-Content -LiteralPath $p -Stream 'rcmcp.test' -Value 'ADS-MARKER' -NoNewline",
      "$a=[IO.File]::GetAttributes($p)",
      "[IO.File]::SetAttributes($p,$a -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)",
      "& compact.exe /C /I /Q $p | Out-Null",
      "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}",
    ].join(";"), { RCMCP_TEST_PATH: file });

    if (longPath) {
      const directory = path.join(root, "long-segment-".repeat(18)); await mkdir(directory);
      const extended = path.join(directory, "full.txt"); expect(extended.length).toBeGreaterThan(260);
      await rename(file, extended); file = extended;
    }
    const result = await fsWrite({ path: file, data: "new-content" });
    expect(result).toMatchObject({ metadataPreserved: true, metadataStrategy: "windows-full", replacedExisting: true });

    const state = JSON.parse(ps([
      "$p=$env:RCMCP_TEST_PATH",
      "$attrs=[IO.File]::GetAttributes($p)",
      "$ads=(Get-Content -LiteralPath $p -Stream 'rcmcp.test' -Raw).ToString()",
      "[pscustomobject]@{ads=$ads;hidden=(($attrs -band [IO.FileAttributes]::Hidden) -ne 0);system=(($attrs -band [IO.FileAttributes]::System) -ne 0);compressed=(($attrs -band [IO.FileAttributes]::Compressed) -ne 0)} | ConvertTo-Json -Compress",
    ].join(";"), { RCMCP_TEST_PATH: path.toNamespacedPath(file) })) as { ads: string; hidden: boolean; system: boolean; compressed: boolean };
    expect(state).toEqual({ ads: "ADS-MARKER", hidden: true, system: true, compressed: true });
  });

  it("falls back in-place for sparse files instead of replacing unsupported metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-win-sparse-meta-"));
    roots.push(root);
    const file = path.join(root, "sparse.txt");
    await writeFile(file, "old");
    ps("& fsutil.exe sparse setflag $env:RCMCP_TEST_PATH | Out-Null; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}", { RCMCP_TEST_PATH: file });
    const result = await fsWrite({ path: file, data: "new" });
    expect(result).toMatchObject({
      atomic: false, directTarget: true, metadataPreserved: true, metadataStrategy: "direct-existing", replacedExisting: true,
    });
    const sparse = ps("$a=[IO.File]::GetAttributes($env:RCMCP_TEST_PATH); (($a -band [IO.FileAttributes]::SparseFile) -ne 0)", { RCMCP_TEST_PATH: file });
    expect(sparse).toBe("True");
  });
});


it.skipIf(process.platform !== "win32")("rewrites hidden sparse files in place without clearing attributes or requiring creation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-win-hidden-sparse-")); roots.push(root);
  const file = path.join(root, "hidden.txt"); await writeFile(file, "old payload that must be truncated");
  ps([
    "$ErrorActionPreference='Stop'",
    "& fsutil.exe sparse setflag $env:RCMCP_TEST_PATH | Out-Null",
    "if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}",
    "$a=[IO.File]::GetAttributes($env:RCMCP_TEST_PATH)",
    "[IO.File]::SetAttributes($env:RCMCP_TEST_PATH,$a -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System)",
  ].join(";"), { RCMCP_TEST_PATH: file });
  expect(await fsWrite({ path: file, data: "new" })).toMatchObject({ atomic: false, metadataStrategy: "direct-existing", metadataPreserved: true });
  expect(await readFile(file, "utf8")).toBe("new");
  const attributes = JSON.parse(ps("$a=[IO.File]::GetAttributes($env:RCMCP_TEST_PATH);@{hidden=(($a-band[IO.FileAttributes]::Hidden)-ne 0);system=(($a-band[IO.FileAttributes]::System)-ne 0);sparse=(($a-band[IO.FileAttributes]::SparseFile)-ne 0)}|ConvertTo-Json -Compress", { RCMCP_TEST_PATH: file }));
  expect(attributes).toEqual({ hidden: true, system: true, sparse: true });
});
