import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { windowsNativePath } from "../apps/agent/src/windows-native-path.ts";
import { beginTransfer, destinationVersion, finalizeTransfer } from "../apps/agent/src/transfer-staging.ts";
import { replaceByRename } from "../apps/agent/src/filesystem-atomic.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("converts local, UNC and existing native Windows paths without interpreting shell characters", () => {
  expect(windowsNativePath(String.raw`C:\synthetic\folder with spaces\file.bin`)).toBe(String.raw`\\?\C:\synthetic\folder with spaces\file.bin`);
  expect(windowsNativePath(String.raw`\\example.invalid\share\file.bin`)).toBe(String.raw`\\?\UNC\example.invalid\share\file.bin`);
  expect(windowsNativePath(String.raw`\\?\C:\synthetic\literal'$file.bin`)).toBe(String.raw`\\?\C:\synthetic\literal'$file.bin`);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-native-paths-"));
  roots.push(root);
  const directory = path.join(root, "segment-".repeat(12));
  await mkdir(directory);
  const destination = path.join(directory, "fișier '$ ".repeat(15) + ".bin");
  expect(destination.length).toBeGreaterThan(260);
  return { root, destination };
}

async function acl(target: string) {
  const result = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:RCMCP_FIXTURE_PATH
$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
$aces=@(foreach($ace in $raw.DiscretionaryAcl){$bytes=New-Object byte[] $ace.BinaryLength;$ace.GetBinaryForm($bytes,0);[Convert]::ToBase64String($bytes)})
# Windows may normalize only this bookkeeping flag during descriptor application.
# Every permission ACE (in order), identity and other control flag must survive.
$flags=[int]$raw.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited)
[ordered]@{owner=$raw.Owner.Value;group=$raw.Group.Value;flags=$flags;nullDacl=($null -eq $raw.DiscretionaryAcl);aces=$aces}|ConvertTo-Json -Compress`], {
    windowsHide: true, env: { ...process.env, RCMCP_FIXTURE_PATH: windowsNativePath(target) }, timeout: 10000,
  });
  return result.stdout.trim();
}

describe.skipIf(process.platform !== "win32")("native Windows extended transfer paths", () => {
  it.each([false, true])("publishes a long Unicode literal target (existing=%s) and preserves source/ACLs", async existing => {
    const { root, destination } = await fixture();
    const source = path.join(root, "source.bin");
    await writeFile(source, "synthetic-new-payload");
    if (existing) await writeFile(destination, "synthetic-old-payload");
    const originalAcl = existing ? await acl(destination) : undefined;
    const stage = await beginTransfer(destination);
    await writeFile(stage.temporaryPath, await readFile(source));
    const result = await finalizeTransfer({ path: stage.temporaryPath, destination, expectedDestination: stage.expectedDestination, expectedBytes: 21 });
    expect(result.atomic).toBe(true);
    expect(result.metadataStrategy).toBe(existing ? "windows-full" : "windows-private");
    expect(await readFile(destination, "utf8")).toBe("synthetic-new-payload");
    expect(await readFile(source, "utf8")).toBe("synthetic-new-payload");
    if (originalAcl) expect(await acl(destination)).toBe(originalAcl);
  }, 20000);

  it("detects changed long destinations before publishing and leaves their current data intact", async () => {
    const { destination } = await fixture();
    await writeFile(destination, "old");
    const stage = await beginTransfer(destination);
    await writeFile(stage.temporaryPath, "new");
    await writeFile(destination, "concurrent-current-version");
    await expect(finalizeTransfer({ path: stage.temporaryPath, destination, expectedDestination: stage.expectedDestination, expectedBytes: 3 })).rejects.toThrow("Destination changed");
    expect(await readFile(destination, "utf8")).toBe("concurrent-current-version");
    expect(await readFile(stage.temporaryPath, "utf8")).toBe("new");
  }, 20000);

  it("retains kernel no-replace behavior for long-path moves", async () => {
    const { root, destination } = await fixture();
    const source = path.join(root, "move-source.bin");
    await writeFile(source, "source");
    await writeFile(destination, "destination");
    await expect(replaceByRename(source, destination, false)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(source, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("destination");
    const absent = destination + "-new";
    expect(await destinationVersion(absent)).toBe("absent");
    expect((await replaceByRename(source, absent, false)).atomic).toBe(true);
    expect(await readFile(absent, "utf8")).toBe("source");
  }, 20000);
});
