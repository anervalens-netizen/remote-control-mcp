import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWriteJson, ensureStateDir } from "./state.ts";

export type ActivationResult = { atomic: boolean; replacedExisting: boolean; cleanupPending?: boolean; cleanupPath?: string; cleanupError?: string };

const execFileAsync = promisify(execFile);

type MoveCaptureJournal = {
  version: 1 | 2;
  source: string;
  capture: string;
  createdAt: string;
  destination?: string;
  phase?: "captured" | "activating" | "destination-durable";
  destinationIdentity?: { dev: number; ino: number; birthtimeMs: number };
};

const moveCaptureJournalRoot = ensureStateDir("move-captures");

function moveCaptureJournalPath(id: string): string {
  return path.join(moveCaptureJournalRoot, `${id}.json`);
}

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeMoveCaptureJournal(target: string): Promise<void> {
  await rm(target, { force: true });
  if (process.platform !== "win32") {
    const synced = await syncContainingDirectory(target);
    if (!synced.synced) throw new Error("Move-capture journal cleanup durability failed: " + (synced.error ?? "directory fsync failed"));
  }
}

export async function recoverMoveCaptures() {
  await mkdir(moveCaptureJournalRoot, { recursive: true });
  const result = { restored: 0, cleared: 0, retained: 0, activatedRetained: 0, errors: [] as string[] };
  for (const name of await readdir(moveCaptureJournalRoot)) {
    if (!name.endsWith(".json")) continue;
    const journalFile = path.join(moveCaptureJournalRoot, name);
    let journal: MoveCaptureJournal;
    try {
      journal = JSON.parse(await readFile(journalFile, "utf8")) as MoveCaptureJournal;
      if (![1, 2].includes(journal.version) || !journal.source || !journal.capture) throw new Error("invalid journal");
    } catch (error) {
      result.errors.push(journalFile + ": " + (error instanceof Error ? error.message : String(error)));
      continue;
    }
    try {
      if (!await pathExists(journal.capture)) {
        await removeMoveCaptureJournal(journalFile);
        result.cleared += 1;
        continue;
      }
      // A rename preserves the staging entry identity. Recording it before
      // activation closes the crash window before the post-activation marker.
      // Keep the old capture quarantined rather than deleting potentially
      // valuable data or resurrecting the original source of a committed move.
      if (journal.version === 2 && journal.destination && journal.destinationIdentity &&
          (journal.phase === "activating" || journal.phase === "destination-durable")) {
        const destinationEntry = await lstat(journal.destination).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        });
        const identity = journal.destinationIdentity;
        if (destinationEntry && destinationEntry.dev === identity.dev && destinationEntry.ino === identity.ino &&
            destinationEntry.birthtimeMs === identity.birthtimeMs) {
          result.retained += 1;
          result.activatedRetained += 1;
          continue;
        }
      }
      if (await pathExists(journal.source)) {
        result.retained += 1;
        continue;
      }
      await replaceByRename(journal.capture, journal.source, false);
      if (process.platform !== "win32") {
        const synced = await syncContainingDirectory(journal.source);
        if (!synced.synced) throw new Error("restored source parent fsync failed: " + (synced.error ?? "directory fsync failed"));
      }
      await removeMoveCaptureJournal(journalFile);
      result.restored += 1;
    } catch (error) {
      result.errors.push(journalFile + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return result;
}

export async function cloneExistingMetadata(source: string, destination: string, signal?: AbortSignal): Promise<"posix-all" | "windows-full" | "none"> {
  if (process.platform === "win32") {
    try {
      const script = `$ErrorActionPreference='Stop'
$source=$env:RCMCP_META_SOURCE
$dest=$env:RCMCP_META_DEST
$attributes=[IO.File]::GetAttributes($source)
$unsupported=[IO.FileAttributes]::Encrypted -bor [IO.FileAttributes]::SparseFile
if(($attributes -band $unsupported) -ne 0){ exit 42 }
$acl=Get-Acl -LiteralPath $source
# Set-Acl/SetAccessControl recompute inherited ACEs from the current parent.
# A relocated private file can legitimately retain a different inherited ACL.
# Apply its exact descriptor without changing the original inheritance policy.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RcMcpFileSecurity {
  [DllImport("advapi32.dll", EntryPoint="SetFileSecurityW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool SetFileSecurity(string path, uint information, byte[] descriptor);
  public static void Apply(string path, byte[] descriptor, bool protect) {
    uint information=7u | (protect ? 0x80000000u : 0x20000000u);
    if(!SetFileSecurity(path,information,descriptor)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[RcMcpFileSecurity]::Apply($dest,$acl.GetSecurityDescriptorBinaryForm(),$acl.AreAccessRulesProtected)
$streams=@(Get-Item -LiteralPath $source -Stream * -Force | Where-Object {$_.Stream -ne ':$DATA'})
if($streams.Count -gt 0){
  # .NET Framework path parsing rejects ADS paths. Open native handles, then
  # stream bounded buffers instead of loading arbitrary stream contents.
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RcMcpAlternateStreams {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
    IntPtr security, uint disposition, uint flags, IntPtr template);
  private static SafeFileHandle Open(string name, uint access, uint disposition) {
    SafeFileHandle handle=CreateFile(name,access,7,IntPtr.Zero,disposition,128,IntPtr.Zero);
    if(handle.IsInvalid){ int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
    return handle;
  }
  public static void Copy(string source, string destination) {
    using(SafeFileHandle read=Open(source,0x80000000,3))
    using(SafeFileHandle write=Open(destination,0x40000000,2))
    using(FileStream input=new FileStream(read,FileAccess.Read,65536,false))
    using(FileStream output=new FileStream(write,FileAccess.Write,65536,false)) {
      input.CopyTo(output,65536); output.Flush(true);
    }
  }
}
'@
  foreach($stream in $streams){ [RcMcpAlternateStreams]::Copy($source+':'+$stream.Stream,$dest+':'+$stream.Stream) }
}
if(($attributes -band [IO.FileAttributes]::Compressed) -ne 0){
  & compact.exe /C /I /Q $dest | Out-Null
  if($LASTEXITCODE -ne 0){ exit $LASTEXITCODE }
}
[IO.File]::SetCreationTimeUtc($dest,[IO.File]::GetCreationTimeUtc($source))
[IO.File]::SetLastAccessTimeUtc($dest,[IO.File]::GetLastAccessTimeUtc($source))
[IO.File]::SetAttributes($dest,$attributes)
function Get-AclSignature($value){
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($value.Sddl)
  $parts=@($raw.Owner.Value,$raw.Group.Value,([string]$value.AreAccessRulesProtected))
  if($null -eq $raw.DiscretionaryAcl){ $parts+='NULL_DACL' }
  else {
    $parts+='DACL'
    foreach($ace in $raw.DiscretionaryAcl){
      $bytes=New-Object byte[] $ace.BinaryLength
      $ace.GetBinaryForm($bytes,0)
      $parts += [Convert]::ToBase64String($bytes)
    }
  }
  return ($parts -join '|')
}
# Keep owner/group, protection and every ordered ACE byte identical. Windows
# may normalize only the descriptor's AUTO_INHERITED bookkeeping bit during descriptor application.
if((Get-AclSignature (Get-Acl -LiteralPath $dest)) -ne (Get-AclSignature $acl)){ throw 'Cloned Windows ACL permissions differ from source ACL' }`;
      await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, RCMCP_META_SOURCE: source, RCMCP_META_DEST: destination },
        signal,
      });
      return "windows-full";
    } catch (error) {
      if (process.env.RCMCP_METADATA_DIAGNOSTICS === "1") {
        const detail = error as Error & { stderr?: string };
        console.error("Windows metadata clone:", (detail.stderr || detail.message).slice(0, 1500));
      }
      return "none";
    }
  }
  try {
    await execFileAsync("cp", ["--attributes-only", "--preserve=all", "--", source, destination], { windowsHide: true, maxBuffer: 1024 * 1024, signal });
    const [sourceInfo, destinationInfo] = await Promise.all([stat(source), stat(destination)]);
    const sameOwnership = sourceInfo.uid === destinationInfo.uid && sourceInfo.gid === destinationInfo.gid;
    const sameMode = (sourceInfo.mode & 0o7777) === (destinationInfo.mode & 0o7777);
    return sameOwnership && sameMode ? "posix-all" : "none";
  } catch {
    return "none";
  }
}

export type WindowsDirectRewriteMetadata = {
  attributes: number;
  sparse: boolean;
  encrypted: boolean;
  compressed: boolean;
};

export async function captureWindowsDirectRewriteMetadata(source: string): Promise<WindowsDirectRewriteMetadata | null> {
  if (process.platform !== "win32") return null;
  const script = `$a=[IO.File]::GetAttributes($env:RCMCP_META_SOURCE)
[pscustomobject]@{
  attributes=[int]$a
  sparse=(($a -band [IO.FileAttributes]::SparseFile) -ne 0)
  encrypted=(($a -band [IO.FileAttributes]::Encrypted) -ne 0)
  compressed=(($a -band [IO.FileAttributes]::Compressed) -ne 0)
} | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, RCMCP_META_SOURCE: source },
  });
  return JSON.parse(stdout.trim()) as WindowsDirectRewriteMetadata;
}

export async function restoreWindowsDirectRewriteMetadata(target: string, before: WindowsDirectRewriteMetadata): Promise<void> {
  if (process.platform !== "win32") return;
  const script = `$ErrorActionPreference='Stop'
$target=$env:RCMCP_META_DEST
$before=ConvertFrom-Json $env:RCMCP_META_PROFILE
if($before.sparse){
  & fsutil.exe sparse setflag $target | Out-Null
  if($LASTEXITCODE -ne 0){ throw 'Unable to restore sparse-file state' }
}
$after=[IO.File]::GetAttributes($target)
$checks=@(
  @('SparseFile',[IO.FileAttributes]::SparseFile,[bool]$before.sparse),
  @('Encrypted',[IO.FileAttributes]::Encrypted,[bool]$before.encrypted),
  @('Compressed',[IO.FileAttributes]::Compressed,[bool]$before.compressed)
)
foreach($check in $checks){
  $present=(($after -band $check[1]) -ne 0)
  if($present -ne $check[2]){ throw ('Windows direct rewrite did not preserve ' + $check[0]) }
}
$mutableMask=[IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::System -bor [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::Temporary -bor [IO.FileAttributes]::NotContentIndexed -bor [IO.FileAttributes]::Offline
$beforeMutable=([IO.FileAttributes][int]$before.attributes) -band $mutableMask
$afterMutable=$after -band $mutableMask
if($beforeMutable -ne $afterMutable){ [IO.File]::SetAttributes($target, ($after -band (-bnot $mutableMask)) -bor $beforeMutable) }`;
  await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      RCMCP_META_DEST: target,
      RCMCP_META_PROFILE: JSON.stringify(before),
    },
  });
}

async function cloneWindowsTreeMetadata(source: string, destination: string): Promise<"windows-full" | "none"> {
  if (process.platform !== "win32") return "none";
  try {
    const script = `$ErrorActionPreference='Stop'
$source=$env:RCMCP_META_SOURCE
$dest=$env:RCMCP_META_DEST
& robocopy.exe $source $dest /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
$robocopyCode=$LASTEXITCODE
if($robocopyCode -gt 7){ throw "robocopy metadata copy failed with code $robocopyCode" }

function Copy-RcmcpTreeMetadata([string]$s,[string]$d){
  if(-not (Test-Path -LiteralPath $d)){ throw "missing copied target: $d" }
  $attrs=[IO.File]::GetAttributes($s)
  $unsupported=[IO.FileAttributes]::Encrypted -bor [IO.FileAttributes]::SparseFile
  if(($attrs -band $unsupported) -ne 0){ throw "unsupported Windows tree metadata on $s" }
  $acl=Get-Acl -LiteralPath $s
  Set-Acl -LiteralPath $d -AclObject $acl
  $destAttrs=[IO.File]::GetAttributes($d)
  $sourceCompressed=(($attrs -band [IO.FileAttributes]::Compressed) -ne 0)
  $destCompressed=(($destAttrs -band [IO.FileAttributes]::Compressed) -ne 0)
  if($sourceCompressed -ne $destCompressed){
    if($sourceCompressed){ & compact.exe /C /I /Q $d | Out-Null }
    else { & compact.exe /U /I /Q $d | Out-Null }
    if($LASTEXITCODE -ne 0){ throw "compact metadata copy failed on $d" }
  }
  [IO.File]::SetCreationTimeUtc($d,[IO.File]::GetCreationTimeUtc($s))
  [IO.File]::SetLastAccessTimeUtc($d,[IO.File]::GetLastAccessTimeUtc($s))
  [IO.File]::SetLastWriteTimeUtc($d,[IO.File]::GetLastWriteTimeUtc($s))
  [IO.File]::SetAttributes($d,$attrs)
}

$pairs=New-Object System.Collections.Generic.List[object]
$pairs.Add([pscustomobject]@{Source=$source;Dest=$dest})
Get-ChildItem -LiteralPath $source -Force -Recurse | ForEach-Object {
  $relative=$_.FullName.Substring($source.Length).TrimStart('\\')
  $pairs.Add([pscustomobject]@{Source=$_.FullName;Dest=(Join-Path $dest $relative)})
}
$pairs | Sort-Object { $_.Source.Length } -Descending | ForEach-Object { Copy-RcmcpTreeMetadata $_.Source $_.Dest }`;
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, RCMCP_META_SOURCE: source, RCMCP_META_DEST: destination },
    });
    return "windows-full";
  } catch {
    return "none";
  }
}

async function syncCopiedTree(target: string): Promise<void> {
  if (process.platform === "win32") return;
  const info = await lstat(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of await readdir(target)) await syncCopiedTree(path.join(target, entry));
    const directory = await open(target, "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return;
  }
  if (info.isFile()) {
    const file = await open(target, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
}

export async function syncContainingDirectory(target: string): Promise<{ synced: boolean; error?: string }> {
  if (process.platform === "win32") return { synced: false };
  let directory;
  try {
    directory = await open(path.dirname(target), "r");
    await directory.sync();
    return { synced: true };
  } catch (error) {
    return { synced: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function windowsNoReplaceRename(source: string, destination: string): Promise<void> {
  const [sourceInfo, destinationParent] = await Promise.all([lstat(source), stat(path.dirname(destination))]);
  if (sourceInfo.dev !== destinationParent.dev) {
    const error = new Error(`Cross-device rename: ${source} -> ${destination}`) as NodeJS.ErrnoException;
    error.code = "EXDEV";
    throw error;
  }
  const script = `$ErrorActionPreference='Stop'
$source=$env:RCMCP_MOVE_SOURCE
$destination=$env:RCMCP_MOVE_DEST
if([IO.Directory]::Exists($source)){ [IO.Directory]::Move($source,$destination) }
else { [IO.File]::Move($source,$destination) }`;
  try {
    await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, RCMCP_MOVE_SOURCE: source, RCMCP_MOVE_DEST: destination },
    });
  } catch (error) {
    let sourceStillExists = false;
    let destinationExists = false;
    try { await lstat(source); sourceStillExists = true; }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
    try { await lstat(destination); destinationExists = true; }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
    if (sourceStillExists && destinationExists) {
      const existsError = new Error(`Destination already exists: ${destination}`) as NodeJS.ErrnoException;
      existsError.code = "EEXIST";
      throw existsError;
    }
    throw error;
  }
}

export async function replaceByRename(source: string, destination: string, force: boolean): Promise<ActivationResult> {
  if (!force && process.platform === "win32") {
    await windowsNoReplaceRename(source, destination);
    return { atomic: true, replacedExisting: false };
  }
  if (!force) {
    const [sourceInfo, destinationParent] = await Promise.all([lstat(source), stat(path.dirname(destination))]);
    if (sourceInfo.dev !== destinationParent.dev) {
      const error = new Error(`Cross-device rename: ${source} -> ${destination}`) as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    }
    try {
      await execFileAsync("mv", ["--no-clobber", "--no-target-directory", "--", source, destination], { windowsHide: true, maxBuffer: 1024 * 1024 });
    } catch (error) {
      let sourceStillExists = false;
      let destinationExists = false;
      try { await lstat(source); sourceStillExists = true; }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
      try { await lstat(destination); destinationExists = true; }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe; }
      if (sourceStillExists && destinationExists) {
        const existsError = new Error(`Destination already exists: ${destination}`) as NodeJS.ErrnoException;
        existsError.code = "EEXIST";
        throw existsError;
      }
      throw error;
    }
    return { atomic: true, replacedExisting: false };
  }

  let destinationExists = false;
  try { await lstat(destination); destinationExists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (destinationExists && !force) {
    const error = new Error(`Destination already exists: ${destination}`) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  try {
    await rename(source, destination);
    return { atomic: true, replacedExisting: destinationExists };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EXDEV") throw error;
    if (!force || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
  }

  const parsed = path.parse(destination);
  const backup = path.join(parsed.dir, `.rcmcp-replace-${randomUUID()}.bak`);
  let backedUp = false;
  let activated = false;
  try {
    try { await rename(destination, backup); backedUp = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    activated = true;
  } catch (error) {
    if (!activated && backedUp) {
      try { await rename(backup, destination); } catch { /* retain backup for explicit recovery */ }
    }
    throw error;
  }

  if (backedUp) {
    try {
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      return {
        atomic: false,
        replacedExisting: true,
        cleanupPending: true,
        cleanupPath: backup,
        cleanupError: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { atomic: !backedUp, replacedExisting: backedUp };
}

export async function existingMode(target: string): Promise<number | undefined> {
  try { return (await stat(target)).mode; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function movePath(source: string, destination: string, force: boolean) {
  const sourceInfo = await lstat(source, { bigint: true });
  let destinationInfo;
  try { destinationInfo = await lstat(destination, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // rename onto another name for the same inode can succeed without removing
  // either name. Do not turn this no-op into an implicit unlink.
  if (destinationInfo && (path.resolve(source) === path.resolve(destination) || (sourceInfo.ino !== 0n && sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino))) {
    if (!force) throw Object.assign(new Error("Destination already exists"), { code: "EEXIST" });
    return { ok: true, atomic: true, crossDevice: false, sourceRemoved: false, destinationAtomic: true, outcome: "same_file_noop" as const };
  }
  try {
    const activation = await replaceByRename(source, destination, force);
    return {
      ok: true, atomic: activation.atomic, crossDevice: false, sourceRemoved: true, destinationAtomic: activation.atomic,
      ...(activation.cleanupPending ? {
        cleanupPending: true, cleanupPath: activation.cleanupPath, cleanupError: activation.cleanupError,
      } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  const parsed = path.parse(destination);
  const temporary = path.join(parsed.dir, `.rcmcp-move-${randomUUID()}.tmp`);
  const sourceParsed = path.parse(source);
  const captureId = randomUUID();
  const sourceCapture = path.join(sourceParsed.dir, `.rcmcp-source-capture-${captureId}.tmp`);
  const captureJournal = moveCaptureJournalPath(captureId);
  let activated = false;
  let captured = false;
  let captureJournalActive = false;
  try {
    const journal: MoveCaptureJournal = {
      version: 2, source, capture: sourceCapture, destination,
      phase: "captured", createdAt: new Date().toISOString(),
    };
    atomicWriteJson(captureJournal, journal);
    captureJournalActive = true;
    await rename(source, sourceCapture);
    captured = true;
    if (process.platform !== "win32") {
      const captureDirectorySync = await syncContainingDirectory(source);
      if (!captureDirectorySync.synced) {
        throw new Error("Cross-device move source capture durability failed: " + (captureDirectorySync.error ?? "directory fsync failed"));
      }
    }
    const sourceEntry = await lstat(sourceCapture);
    let metadataStrategy: "posix-all" | "windows-full" | "none" | undefined;
    if (process.platform !== "win32") {
      await execFileAsync("cp", ["-a", "--preserve=all", "--", sourceCapture, temporary], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      metadataStrategy = "posix-all";
    } else {
      if (sourceEntry.isDirectory()) {
        await mkdir(temporary, { recursive: true });
        metadataStrategy = await cloneWindowsTreeMetadata(sourceCapture, temporary);
      } else {
        await cp(sourceCapture, temporary, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
        if (sourceEntry.isFile()) metadataStrategy = await cloneExistingMetadata(sourceCapture, temporary);
      }
      const windowsMetadataPreserved = sourceEntry.isDirectory()
        ? metadataStrategy === "windows-full"
        : sourceEntry.isFile()
          ? metadataStrategy === "windows-full"
          : true;
      if (!windowsMetadataPreserved) {
        throw new Error("Cross-device move could not preserve source metadata (" + metadataStrategy + ")");
      }
    }
    let destinationDurable = false;
    let sourceRemovalDurable = false;
    if (process.platform !== "win32") {
      await syncCopiedTree(temporary);
      const stagingDirectorySync = await syncContainingDirectory(temporary);
      if (!stagingDirectorySync.synced) throw new Error("Cross-device move staging durability failed: " + (stagingDirectorySync.error ?? "directory fsync failed"));
    }

    const stagedEntry = await lstat(temporary);
    journal.phase = "activating";
    journal.destinationIdentity = { dev: stagedEntry.dev, ino: stagedEntry.ino, birthtimeMs: stagedEntry.birthtimeMs };
    atomicWriteJson(captureJournal, journal);
    const activation = await replaceByRename(temporary, destination, force);
    activated = true;
    const destinationCleanup = activation.cleanupPending ? {
      destinationCleanupPending: true,
      destinationCleanupPath: activation.cleanupPath,
      destinationCleanupError: activation.cleanupError,
    } : {};

    if (process.platform !== "win32") {
      await syncCopiedTree(destination);
      const destinationDirectorySync = await syncContainingDirectory(destination);
      if (!destinationDirectorySync.synced) {
        return {
          ok: false, atomic: false, crossDevice: true, sourceRemoved: true, sourceQuarantined: true,
          destinationAtomic: activation.atomic, destinationDurable: false, sourceRemovalDurable: true,
          cleanupPending: true, cleanupPath: sourceCapture,
          recovery: "destination_activated_source_capture_retained",
          error: "Cross-device move destination durability failed: " + (destinationDirectorySync.error ?? "directory fsync failed"),
          ...destinationCleanup,
        };
      }
      destinationDurable = true;
    }

    // Windows has completed activation, but crash durability is not verified.
    journal.phase = destinationDurable ? "destination-durable" : "activating";
    atomicWriteJson(captureJournal, journal);
    try {
      await rm(sourceCapture, { recursive: true, force: false });
      captured = false;
      await removeMoveCaptureJournal(captureJournal);
      captureJournalActive = false;
    } catch (error) {
      return {
        ok: false, atomic: false, crossDevice: true, sourceRemoved: true, sourceQuarantined: true,
        destinationAtomic: activation.atomic, destinationDurable, sourceRemovalDurable: false,
        cleanupPending: true, cleanupPath: sourceCapture,
        recovery: "source_capture_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
        ...destinationCleanup,
      };
    }

    if (process.platform !== "win32") {
      const sourceDirectorySync = await syncContainingDirectory(source);
      sourceRemovalDurable = sourceDirectorySync.synced;
      if (!sourceDirectorySync.synced) {
        return {
          ok: false, atomic: false, crossDevice: true, sourceRemoved: true, destinationAtomic: activation.atomic,
          destinationDurable, sourceRemovalDurable: false,
          recovery: "destination_durable_source_removed_parent_unsynced",
          error: "Cross-device move source-directory durability failed: " + (sourceDirectorySync.error ?? "directory fsync failed"),
          ...destinationCleanup,
        };
      }
    }

    return {
      ok: true, atomic: false, crossDevice: true, sourceRemoved: true, destinationAtomic: activation.atomic,
      destinationDurable, sourceRemovalDurable,
      durabilityVerification: process.platform === "win32" ? "unverified" : "confirmed",
      ...(metadataStrategy ? { metadataPreserved: metadataStrategy !== "none", metadataStrategy } : {}),
      ...destinationCleanup,
    };
  } catch (error) {
    if (!activated && captured) {
      try {
        await replaceByRename(sourceCapture, source, false);
        captured = false;
        await removeMoveCaptureJournal(captureJournal);
        captureJournalActive = false;
        if (process.platform !== "win32") {
          const restoreDirectorySync = await syncContainingDirectory(source);
          if (!restoreDirectorySync.synced) {
            throw new Error("Restored source but source-directory durability failed: " + (restoreDirectorySync.error ?? "directory fsync failed"));
          }
        }
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Cross-device move failed before destination activation; captured source retained at ${sourceCapture}`,
        );
      }
    }
    throw error;
  } finally {
    if (!activated) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    if (!captured && captureJournalActive) {
      await removeMoveCaptureJournal(captureJournal).catch(() => undefined);
    }
  }
}
