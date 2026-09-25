import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { copyFile, utimes, chmod, cp, lstat, stat, unlink, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);
async function sourceLinkType(source: string): Promise<"dir" | "file" | undefined> {
  if (process.platform !== "win32") return undefined;
  // Read the source reparse-point attributes, not the destination-relative
  // target (which may not have been copied yet). Dangling directory links
  // retain their directory kind in the Windows attribute record.
  const { stdout } = await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; if(([IO.File]::GetAttributes($env:RCMCP_COPY_LINK) -band [IO.FileAttributes]::Directory) -ne 0){'dir'}else{'file'}"], {
    windowsHide: true, timeout: 10000, maxBuffer: 1024,
    env: { ...process.env, RCMCP_COPY_LINK: source },
  });
  const type = stdout.trim();
  if (type !== "dir" && type !== "file") throw new Error("Cannot determine source symlink type");
  return type;
}

/** Count actual effects. In no-clobber mode EEXIST is a skip, including races. */
function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  return signal?.reason !== undefined && typeof signal.reason === "object" && signal.reason !== null
    && "name" in signal.reason && (signal.reason as { name?: unknown }).name === "TimeoutError";
}

export async function copyPath(source: string, destination: string, recursive: boolean, force: boolean, signal?: AbortSignal) {
  let copied = 0, skipped = 0;
  let cancelled = false, timedOut = false;
  let mutationStarted = false;
  const check = () => signal?.throwIfAborted();
  const cancellationReceipt = () => ({ ok: false, atomic: false, copied, skipped, outcome: "failed" as const, cancelled: true, timedOut: isTimeoutAbort(signal), partialEffectsPossible: false, error: "The copy was cancelled before the first mutation" });
  if (signal?.aborted) {
    return cancellationReceipt();
  }
  const visit = async (from: string, to: string): Promise<void> => {
    check();
    const info = await lstat(from);
    check();
    if (info.isDirectory()) {
      if (!recursive) throw new Error("Recursive copy is required for a directory");
      let created = false;
      try { await mkdir(to, { mode: (info.mode & 0o7777) | 0o700 }); copied++; created = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const target = await lstat(to);
        if (!target.isDirectory()) {
          if (!force) { skipped++; return; }
          throw new Error("Cannot copy directory onto non-directory");
        }
      }
      try {
        check();
        const entries = await readdir(from);
        check();
        if (!created && entries.length === 0) skipped++;
        for (const name of entries) {
          check();
          await visit(path.join(from, name), path.join(to, name));
          check();
        }
      } finally {
        // Restoration must run even when cancellation interrupts traversal.
        if (created && process.platform !== "win32") await chmod(to, info.mode & 0o7777);
      }
      check();
    } else {
      if (info.isFile()) {
        if (force) {
          const previous = await lstat(to).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          });
          check();
          if (previous) {
            if (previous.isDirectory()) throw new Error("Cannot copy a file onto a directory");
            if (previous.dev === info.dev && previous.ino === info.ino) throw new Error("Cannot copy a file onto itself");
            // Match fs.cp's replacement behavior: replace an existing link,
            // never follow it and overwrite an unrelated target.
            check();
            await unlink(to);
            check();
          }
        }
        check();
        try { await copyFile(from, to, constants.COPYFILE_EXCL); }
        catch (error) {
          if (!force && (error as NodeJS.ErrnoException).code === "EEXIST") { skipped++; return; }
          throw error;
        }
        // The bytes exist even if chmod/stat/utimes subsequently fails.
        copied++;
        const sourceMode = info.mode & 0o7777;
        try {
          check();
          if ((sourceMode & 0o200) === 0) { await chmod(to, sourceMode | 0o200); check(); }
          const freshSource = await stat(from);
          check();
          await utimes(to, freshSource.atime, freshSource.mtime);
        } finally {
          // Includes errors/aborts after chmod and stat, not just utimes.
          await chmod(to, sourceMode);
        }
        check();
        return;
      }
      check();
      try {
        if (info.isSymbolicLink()) {
          const target = await readlink(from), type = await sourceLinkType(from);
          check();
          if (force) await unlink(to).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
          check();
          await symlink(target, to, type);
        } else {
          await cp(from, to, { force, errorOnExist: !force, preserveTimestamps: true, verbatimSymlinks: true });
        }
        copied++;
        check();
      } catch (error) {
        if (!force && ["EEXIST", "ERR_FS_CP_EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) { skipped++; return; }
        throw error;
      }
    }
  };
  // Retain cp's self/descendant protection before recursive destination creation.
  let error: string | undefined;
  try {
    const { realpath } = await import("node:fs/promises");
    const sourceInfo = await lstat(source);
    check();
    const resolvedSource = path.resolve(source);
    const sourceReal = sourceInfo.isDirectory() ? await realpath(source)
      : path.join(await realpath(path.dirname(resolvedSource)), path.basename(resolvedSource));
    check();
    const resolvedDestination = path.resolve(destination);
    let parent = path.dirname(resolvedDestination), suffix = path.basename(resolvedDestination);
    while (true) {
      try { parent = path.join(await realpath(parent), suffix); check(); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        suffix = path.join(path.basename(parent), suffix); parent = path.dirname(parent);
      }
    }
    const relative = path.relative(sourceReal, parent);
    if (relative === "" || sourceInfo.isDirectory() && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("Cannot copy a path into itself");
    check();
    mutationStarted = true;
    await mkdir(path.dirname(destination), { recursive: true });
    check();
    await visit(source, destination);
  } catch (cause) {
    if (signal?.aborted || cause instanceof DOMException && cause.name === "AbortError") {
      cancelled = true;
      timedOut = isTimeoutAbort(signal);
      if (cause !== signal?.reason && !(cause instanceof DOMException && ["AbortError", "TimeoutError"].includes(cause.name))) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      if (!mutationStarted) throw cause;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const partialEffectsPossible = mutationStarted && (error !== undefined || cancelled);
  return {
    ok: error === undefined && !cancelled, atomic: false, copied, skipped,
    outcome: error ? "failed" : cancelled ? partialEffectsPossible ? "partial" : "failed" : skipped ? copied ? "partial" : "skipped" : "copied",
    ...(skipped ? { reason: "destination_exists" } : {}),
    ...(error ? { error, partialEffectsPossible: true } : {}),
    ...(cancelled ? { cancelled: true, timedOut, partialEffectsPossible } : signal ? { cancelled: false, timedOut: false } : {}),
  };
}
