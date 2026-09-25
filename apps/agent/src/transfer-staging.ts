import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { link, lstat, mkdir, mkdtemp, open, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { cloneExistingMetadata, syncContainingDirectory } from "./filesystem-atomic.ts";

const execute = promisify(execFile);
async function powershell(script: string, target: string, signal?: AbortSignal) {
  return execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script], {
    windowsHide: true, signal, env: { ...process.env, RCMCP_TRANSFER_PATH: target }, maxBuffer: 1024 * 1024,
  });
}

export async function destinationVersion(target: string, signal?: AbortSignal): Promise<string> {
  try {
    const info = await lstat(target, { bigint: true });
    // Include ctime (ACL/ownership changes), identity, and content changes.
    const acl = process.platform === "win32"
      ? (await powershell("(Get-Acl -LiteralPath $env:RCMCP_TRANSFER_PATH).Sddl", target, signal)).stdout.trim() : "";
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid, info.gid, acl].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

export async function beginTransfer(destination: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await mkdir(path.dirname(destination), { recursive: true });
  const expectedDestination = await destinationVersion(destination, signal);
  const directory = await mkdtemp(path.join(path.dirname(destination), ".rcmcp-transfer-"));
  try {
    if (process.platform === "win32") {
      // No payload exists until inheritance is disabled and only this identity
      // has access. New files retain this owner-only DACL on publication.
      await powershell(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:RCMCP_TRANSFER_PATH -AclObject $acl`, directory, signal);
    }
    signal?.throwIfAborted();
    const temporaryPath = path.join(directory, "payload");
    const file = await open(temporaryPath, "wx", 0o600);
    await file.close();
    return { ok: true, path: destination, temporaryPath, directory, expectedDestination };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeTransfer(input: {
  path: string; destination: string; expectedDestination: string; expectedBytes: number; sourceMode?: number;
}, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (await destinationVersion(input.destination, signal) !== input.expectedDestination) throw new Error("Destination changed during transfer");
  const before = await lstat(input.destination).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const file = await open(input.path, "r+");
  let closed = false;
  let metadataStrategy: string;
  let metadataPath = input.path;
  let publicationPath: string | undefined;
  let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
  let operationError: unknown;
  const cleanupReceipt: { cleanupPending?: boolean; cleanupPath?: string; cleanupError?: string } = {};
  try {
    const staged = await file.stat();
    if (!staged.isFile() || staged.size !== input.expectedBytes) throw new Error("Transfer staging size mismatch");
    const atime = staged.atime, mtime = staged.mtime;
    if (process.platform === "win32") {
      const identity = await file.stat({ bigint: true });
      stagedIdentity = { dev: identity.dev, ino: identity.ino };
      await file.close(); closed = true;
      if (before?.isFile()) {
        // Inherited ACEs are recalculated against the parent when Set-Acl runs.
        // Keep payload writes private, then move the complete verified payload
        // (still owner-only) beside the destination before cloning its ACL.
        // Cloning inside the private directory silently lost inherited entries.
        publicationPath = path.join(path.dirname(input.destination), `.rcmcp-publish-${randomUUID()}.tmp`);
        await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          "$ErrorActionPreference='Stop';[IO.File]::Move($env:RCMCP_PUBLISH_SOURCE,$env:RCMCP_PUBLISH_DEST)"], {
          windowsHide: true, signal, maxBuffer: 1024 * 1024,
          env: { ...process.env, RCMCP_PUBLISH_SOURCE: input.path, RCMCP_PUBLISH_DEST: publicationPath },
        });
        metadataPath = publicationPath;
      }
    }
    if (before?.isFile()) {
      metadataStrategy = await cloneExistingMetadata(input.destination, metadataPath, signal);
      // Do not fall back to chmod/in-place writes: neither preserves both ACLs
      // and atomic activation. Leave the old destination intact on failure.
      if (metadataStrategy === "none") throw new Error("Cannot atomically preserve destination metadata");
    } else {
      // Strip only setuid/setgid/sticky; preserve ordinary source rwx bits. Never import IDs.
      // Windows/legacy sources with no POSIX mode default to owner-only 0600.
      metadataStrategy = process.platform === "win32" ? "windows-private" : "source-posix-mode";
      if (process.platform !== "win32") await file.chmod(input.sourceMode === undefined ? 0o600 : input.sourceMode & 0o777);
    }
    if (!closed) { await file.utimes(atime, mtime); await file.sync(); }
    else {
      // Metadata cloning can restore old timestamps; preserve received mtime.
      const { utimes } = await import("node:fs/promises");
      await utimes(metadataPath, atime, mtime);
    }
    if (!closed) { await file.close(); closed = true; }
    if (await destinationVersion(input.destination, signal) !== input.expectedDestination) throw new Error("Destination changed during transfer metadata preparation");
    signal?.throwIfAborted();
    if (process.platform === "win32" && (!before || before.isFile())) {
      if (before) {
        // Metadata is already cloned and verified on a same-volume sibling.
        // ReplaceFile re-inherits parent ACEs even for a previously relocated
        // private ACL. Rename retains the exact prepared security descriptor.
        // Never use a delete/backup fallback if native replacement is denied.
        await rename(metadataPath, input.destination);
      } else {
        // File.Move provides kernel no-replace publication for new files.
        await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          "$ErrorActionPreference='Stop';[IO.File]::Move($env:RCMCP_REPLACE_SOURCE,$env:RCMCP_REPLACE_DEST)"], {
          windowsHide: true, signal, maxBuffer: 1024 * 1024,
          env: { ...process.env, RCMCP_REPLACE_SOURCE: metadataPath, RCMCP_REPLACE_DEST: input.destination },
        });
      }
    } else if (!before) {
      // Kernel no-replace publication protects a destination created late.
      await link(input.path, input.destination);
      // Publication succeeded even if unlink fails; caller owns stage cleanup.
      await unlink(input.path).catch(error => Object.assign(cleanupReceipt, { cleanupPending: true, cleanupPath: input.path, cleanupError: error instanceof Error ? error.message : String(error) }));
    } else {
      // A same-volume rename is atomic. Do not use the backup/remove fallback.
      await rename(input.path, input.destination);
    }
    const directorySync = await syncContainingDirectory(input.destination);
    return {
      ok: true, atomic: true, destinationAtomic: true, metadataStrategy,
      metadataPreserved: before?.isFile() ?? false, ownershipImported: false,
      destinationChangeCheck: "before-and-after-metadata" as const,
      concurrentMetadataGuaranteed: false,
      ...cleanupReceipt,
      directorySynced: directorySync.synced,
      ...(directorySync.error ? { durabilityError: directorySync.error } : {}),
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!closed) await file.close();
    if (publicationPath && stagedIdentity) {
      try {
        const current = await lstat(publicationPath, { bigint: true }).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        // File.Move is no-replace. If it failed on an existing path, never
        // remove that entry; clean up only this operation's bound file ID.
        if (current?.dev === stagedIdentity.dev && current.ino === stagedIdentity.ino) {
          await rm(publicationPath, { force: true, maxRetries: 2, retryDelay: 50 });
        }
      } catch (cleanupError) {
        const detail = `Publication cleanup pending at ${publicationPath}: ${String(cleanupError)}`;
        if (operationError instanceof Error) operationError.message += `; ${detail}`;
        else console.error(detail);
      }
    }
  }
}
