import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export type SecretMetadata = { alias: string; present: boolean; bytes?: number; updatedAt?: string };
type StoredMeta = { alias: string; bytes: number; updatedAt: string };
type ReplacementTxn = {
  version: 1;
  alias: string;
  tempSecret: string;
  tempMeta: string;
  backupSecret: string;
  backupMeta: string;
  hadSecret: boolean;
  hadMeta: boolean;
};

function defaultRoot(): string {
  return process.env.RCMCP_SECRET_DIR ?? path.join(os.homedir(), ".config", "remote-control-mcp", "secrets");
}

function aliasKey(alias: string): string {
  if (!alias.length) throw new Error("Secret alias must not be empty");
  return createHash("sha256").update(alias, "utf8").digest("hex");
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function syncFile(target: string) {
  const handle = await open(target, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function safeEntryName(name: string): string {
  if (!name || path.basename(name) !== name) throw new Error("Invalid secret recovery entry");
  return name;
}

const aliasLockTails = new Map<string, Promise<void>>();
const SECRET_LOCK_WAIT_MS = 25;
const SECRET_LOCK_TIMEOUT_MS = Number(process.env.RCMCP_SECRET_LOCK_TIMEOUT_MS ?? 10 * 60 * 1000);
const SECRET_LOCK_OWNER_GRACE_MS = 5000;

async function acquireInProcessAliasLock(key: string): Promise<() => void> {
  const previous = aliasLockTails.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  aliasLockTails.set(key, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (aliasLockTails.get(key) === tail) aliasLockTails.delete(key);
  };
}

type FileLockOwner = { pid: number; token: string; createdAt: string; processIdentity?: string };
type FileLockState = { ino: number; mtimeMs: number; owner: FileLockOwner | null };

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

let cachedLinuxClockTicks: number | undefined;
let cachedLinuxBootId: string | undefined;

function linuxClockTicksPerSecond(): number {
  if (cachedLinuxClockTicks !== undefined) return cachedLinuxClockTicks;
  cachedLinuxClockTicks = 100;
  try {
    const configured = Number.parseInt(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1000 }).trim(), 10);
    if (Number.isFinite(configured) && configured > 0) cachedLinuxClockTicks = configured;
  } catch { /* standard Linux fallback */ }
  return cachedLinuxClockTicks;
}

function linuxBootId(): string | null {
  if (process.platform === "win32") return null;
  if (cachedLinuxBootId !== undefined) return cachedLinuxBootId || null;
  try { cachedLinuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { cachedLinuxBootId = ""; }
  return cachedLinuxBootId || null;
}

function linuxBootStartedAtMs(): number | null {
  try {
    const uptimeSeconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0] ?? "");
    return Number.isFinite(uptimeSeconds) ? Date.now() - uptimeSeconds * 1000 : null;
  } catch { return null; }
}

function currentProcessEvidence(pid: number): { identity: string | null; startedAtMs: number | null } | null {
  if (!processExists(pid)) return null;
  if (process.platform === "win32") {
    try {
      const script = "$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue;if($p){$u=$p.StartTime.ToUniversalTime();Write-Output ($u.Ticks.ToString()+'|'+([DateTimeOffset]$u).ToUnixTimeMilliseconds().ToString())}";
      const raw = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 3000, windowsHide: true,
      }).trim();
      const parts = raw.split("|");
      const ticks = parts[0] ?? "";
      const startedAtMs = Number.parseInt(parts[1] ?? "", 10);
      return raw ? { identity: ticks ? "win:" + ticks : null, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null } : null;
    } catch { return { identity: null, startedAtMs: null }; }
  }
  try {
    const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return { identity: null, startedAtMs: null };
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const startTicks = Number.parseInt(fields[19] ?? "", 10);
    if (!Number.isFinite(startTicks)) return { identity: null, startedAtMs: null };
    const clockTicks = linuxClockTicksPerSecond();
    const uptimeSeconds = Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0] ?? "");
    const startedAtMs = Number.isFinite(uptimeSeconds)
      ? Date.now() - uptimeSeconds * 1000 + (startTicks / clockTicks) * 1000
      : null;
    const bootId = linuxBootId();
    return { identity: bootId ? "linux:" + bootId + ":" + startTicks : null, startedAtMs };
  } catch { return { identity: null, startedAtMs: null }; }
}

async function readFileLockState(lockDir: string): Promise<FileLockState | null> {
  let info;
  try { info = await stat(lockDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as FileLockOwner;
    return { ino: info.ino, mtimeMs: info.mtimeMs, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { ino: info.ino, mtimeMs: info.mtimeMs, owner: null };
    }
    throw error;
  }
}

function fileLockStateIsStale(state: FileLockState): boolean {
  const owner = state.owner;
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) {
    return Date.now() - state.mtimeMs > SECRET_LOCK_OWNER_GRACE_MS;
  }
  const evidence = currentProcessEvidence(owner.pid);
  if (!evidence) return true;
  if (owner.processIdentity) {
    if (evidence.identity === owner.processIdentity) return false;
    const legacy = /^linux:(\d+)$/.exec(owner.processIdentity);
    const modern = /^linux:[^:]+:(\d+)$/.exec(evidence.identity ?? "");
    if (legacy && modern && legacy[1] === modern[1]) {
      const createdAtMs = Date.parse(owner.createdAt);
      const bootStartedAtMs = linuxBootStartedAtMs();
      return !(Number.isFinite(createdAtMs) && bootStartedAtMs !== null && createdAtMs >= bootStartedAtMs - SECRET_LOCK_OWNER_GRACE_MS);
    }
    return true;
  }
  const createdAtMs = Date.parse(owner.createdAt);
  return Number.isFinite(createdAtMs) && evidence.startedAtMs !== null
    ? evidence.startedAtMs > createdAtMs + SECRET_LOCK_OWNER_GRACE_MS
    : false;
}

function sameFileLockState(a: FileLockState, b: FileLockState): boolean {
  return a.ino === b.ino
    && a.mtimeMs === b.mtimeMs
    && a.owner?.pid === b.owner?.pid
    && a.owner?.token === b.owner?.token
    && a.owner?.createdAt === b.owner?.createdAt
    && a.owner?.processIdentity === b.owner?.processIdentity;
}

function reclaimGenerationKey(key: string, state: FileLockState): string {
  const fingerprint = JSON.stringify({
    ino: state.ino,
    pid: state.owner?.pid ?? null,
    token: state.owner?.token ?? null,
    createdAt: state.owner?.createdAt ?? null,
    processIdentity: state.owner?.processIdentity ?? null,
  });
  return ".reclaim-" + key + "-" + createHash("sha256").update(fingerprint, "utf8").digest("hex").slice(0, 16);
}

async function reclaimFileLockIfUnchanged(root: string, key: string, lockDir: string, observed: FileLockState): Promise<boolean> {
  const current = await readFileLockState(lockDir);
  if (!current || !sameFileLockState(observed, current) || !fileLockStateIsStale(current)) return false;

  // All contenders for this exact stale generation converge on the same non-empty
  // quarantine target. Once one rename wins, a delayed contender cannot rename a
  // freshly-created live lock into the occupied target.
  const claimDir = path.join(root, reclaimGenerationKey(key, current));
  await mkdir(claimDir, { recursive: true, mode: 0o700 });
  const quarantine = path.join(claimDir, "lock");
  try {
    await rename(lockDir, quarantine);
    await syncDirectory(root);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") return false;
    throw error;
  }
}

async function acquireFileAliasLock(root: string, key: string): Promise<() => Promise<void>> {
  const lockDir = path.join(root, `.lock-${key}`);
  const ownerPath = path.join(lockDir, "owner.json");
  const token = randomUUID();
  const deadline = Date.now() + SECRET_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      try {
        const processIdentity = currentProcessEvidence(process.pid)?.identity ?? undefined;
        await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), ...(processIdentity ? { processIdentity } : {}) } satisfies FileLockOwner) + "\n", { mode: 0o600 });
        await syncFile(ownerPath);
        await syncDirectory(root);
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as FileLockOwner;
          if (owner.token !== token || owner.pid !== process.pid) return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return;
        }
        await rm(lockDir, { recursive: true, force: true });
        await syncDirectory(root);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = await readFileLockState(lockDir);
      if (observed && fileLockStateIsStale(observed) && await reclaimFileLockIfUnchanged(root, key, lockDir, observed)) {
        await syncDirectory(root);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for secret alias lock: ${key}`);
      await new Promise((resolve) => setTimeout(resolve, SECRET_LOCK_WAIT_MS));
    }
  }
}

export class SecretStore {
  readonly root: string;

  constructor(root = defaultRoot()) { this.root = root; }

  private lockKeyFromHash(key: string) { return path.resolve(this.root) + "\0" + key; }

  private async acquireKeyGuard(key: string): Promise<() => Promise<void>> {
    // Queue locally before any asynchronous root preparation so same-process
    // callers preserve invocation order instead of racing through ensureRoot().
    const releaseInProcess = await acquireInProcessAliasLock(this.lockKeyFromHash(key));
    try {
      await this.ensureRoot();
      const releaseFile = await acquireFileAliasLock(this.root, key);
      return async () => {
        try { await releaseFile(); }
        finally { releaseInProcess(); }
      };
    } catch (error) {
      releaseInProcess();
      throw error;
    }
  }

  private acquireAliasGuard(alias: string): Promise<() => Promise<void>> {
    return this.acquireKeyGuard(aliasKey(alias));
  }

  private async withAliasLock<T>(alias: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireAliasGuard(alias);
    try { return await operation(); }
    finally { await release(); }
  }

  private entry(alias: string) {
    const dir = path.join(this.root, aliasKey(alias));
    return {
      dir,
      secret: path.join(dir, "secret"),
      meta: path.join(dir, "meta.json"),
      transaction: path.join(dir, "replace.json"),
    };
  }

  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700).catch(() => undefined);
  }

  private async writeTransaction(entry: ReturnType<SecretStore["entry"]>, transaction: ReplacementTxn) {
    const temporary = path.join(entry.dir, `.replace-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
      await syncFile(temporary);
      await rename(temporary, entry.transaction);
      await syncDirectory(entry.dir);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async recoverLegacyReplacement(alias: string) {
    const entry = this.entry(alias);
    let names: string[];
    try { names = await readdir(entry.dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const secretBackups = names.filter((name) => /^\.secret-.*\.bak$/.test(name));
    const metaBackups = names.filter((name) => /^\.meta-.*\.bak$/.test(name));
    if (!secretBackups.length && !metaBackups.length) return;
    const tempSecrets = names.filter((name) => /^\.secret-.*\.tmp$/.test(name));
    const tempMetas = names.filter((name) => /^\.meta-.*\.tmp$/.test(name));
    const activeComplete = await exists(entry.secret) && await exists(entry.meta);
    if (activeComplete && tempSecrets.length === 0 && tempMetas.length === 0) {
      await Promise.all([...secretBackups, ...metaBackups].map((name) => rm(path.join(entry.dir, name), { force: true })));
      await syncDirectory(entry.dir);
      return;
    }
    if (secretBackups.length > 1 || metaBackups.length > 1) {
      throw new Error(`Secret alias ${alias} has ambiguous recovery backups`);
    }
    if (secretBackups[0]) {
      await rm(entry.secret, { force: true });
      await rename(path.join(entry.dir, secretBackups[0]), entry.secret);
    }
    if (metaBackups[0]) {
      await rm(entry.meta, { force: true });
      await rename(path.join(entry.dir, metaBackups[0]), entry.meta);
    }
    await Promise.all([...tempSecrets, ...tempMetas].map((name) => rm(path.join(entry.dir, name), { force: true })));
    await syncDirectory(entry.dir);
  }

  private async recoverEntry(alias: string) {
    const entry = this.entry(alias);
    let transaction: ReplacementTxn;
    try {
      transaction = JSON.parse(await readFile(entry.transaction, "utf8")) as ReplacementTxn;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.recoverLegacyReplacement(alias);
        return;
      }
      throw error;
    }
    if (transaction.version !== 1 || transaction.alias !== alias) throw new Error("Secret replacement journal mismatch");

    const tempSecret = path.join(entry.dir, safeEntryName(transaction.tempSecret));
    const tempMeta = path.join(entry.dir, safeEntryName(transaction.tempMeta));
    const backupSecret = path.join(entry.dir, safeEntryName(transaction.backupSecret));
    const backupMeta = path.join(entry.dir, safeEntryName(transaction.backupMeta));

    const activeComplete = await exists(entry.secret) && await exists(entry.meta);
    const stagingGone = !(await exists(tempSecret)) && !(await exists(tempMeta));
    if (activeComplete && stagingGone) {
      await rm(backupSecret, { force: true });
      await rm(backupMeta, { force: true });
      await rm(entry.transaction, { force: true });
      await syncDirectory(entry.dir);
      return;
    }

    if (await exists(backupSecret)) {
      await rm(entry.secret, { force: true });
      await rename(backupSecret, entry.secret);
    } else if (!transaction.hadSecret) {
      await rm(entry.secret, { force: true });
    }
    if (await exists(backupMeta)) {
      await rm(entry.meta, { force: true });
      await rename(backupMeta, entry.meta);
    } else if (!transaction.hadMeta) {
      await rm(entry.meta, { force: true });
    }
    await rm(tempSecret, { force: true });
    await rm(tempMeta, { force: true });
    await rm(entry.transaction, { force: true });
    await syncDirectory(entry.dir);
  }

  private async recoverDirectoryLocked(directory: string): Promise<string | null> {
    const transactionPath = path.join(directory, "replace.json");
    try {
      const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as ReplacementTxn;
      if (this.entry(transaction.alias).dir !== directory) throw new Error("Secret recovery journal directory mismatch");
      await this.recoverEntry(transaction.alias);
      return transaction.alias;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const meta = JSON.parse(await readFile(path.join(directory, "meta.json"), "utf8")) as StoredMeta;
      if (this.entry(meta.alias).dir !== directory) throw new Error("Secret metadata directory mismatch");
      await this.recoverEntry(meta.alias);
      return meta.alias;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  async metadata(alias: string): Promise<SecretMetadata> {
    return this.withAliasLock(alias, async () => {
      await this.recoverEntry(alias);
      const entry = this.entry(alias);
      try {
        const raw = JSON.parse(await readFile(entry.meta, "utf8")) as StoredMeta;
        const info = await stat(entry.secret);
        if (raw.alias !== alias) throw new Error("Secret alias metadata mismatch");
        return { alias, present: true, bytes: info.size, updatedAt: info.mtime.toISOString() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { alias, present: false };
        throw error;
      }
    });
  }

  async list(): Promise<SecretMetadata[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const result: SecretMetadata[] = [];
    for (const item of entries) {
      if (!item.isDirectory() || item.name.startsWith(".lock-") || item.name.startsWith(".reclaim-")) continue;
      const dir = path.join(this.root, item.name);
      const release = await this.acquireKeyGuard(item.name);
      try {
        const recoveredAlias = await this.recoverDirectoryLocked(dir);
        if (!recoveredAlias) continue;
        try {
          const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as StoredMeta;
          const info = await stat(path.join(dir, "secret"));
          if (meta.alias !== recoveredAlias) throw new Error("Secret alias metadata mismatch");
          result.push({ alias: meta.alias, present: true, bytes: info.size, updatedAt: info.mtime.toISOString() });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } finally {
        await release();
      }
    }
    return result.sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async read(alias: string): Promise<Buffer> {
    return this.withAliasLock(alias, async () => {
      await this.recoverEntry(alias);
      const entry = this.entry(alias);
      try { return await readFile(entry.secret); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Secret alias not found: ${alias}`);
        throw error;
      }
    });
  }

  async *chunks(alias: string, chunkBytes = 1024 * 1024): AsyncGenerator<Buffer> {
    const release = await this.acquireAliasGuard(alias);
    const entry = this.entry(alias);
    let file;
    try {
      await this.recoverEntry(alias);
      try { file = await open(entry.secret, "r"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Secret alias not found: ${alias}`);
        throw error;
      }
      const buffer = Buffer.alloc(chunkBytes);
      let position = 0;
      while (true) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead <= 0) return;
        yield Buffer.from(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await file?.close().catch(() => undefined);
      await release();
    }
  }

  async put(alias: string, data: Buffer): Promise<SecretMetadata> {
    async function* once() { yield data; }
    return this.putChunks(alias, once());
  }

  async putChunks(alias: string, chunks: AsyncIterable<Buffer>): Promise<SecretMetadata> {
    return this.withAliasLock(alias, async () => {
        await this.ensureRoot();
        const entry = this.entry(alias);
        const entryExisted = await exists(entry.dir);
        await mkdir(entry.dir, { recursive: true, mode: 0o700 });
        if (!entryExisted) await syncDirectory(this.root);
        await chmod(entry.dir, 0o700).catch(() => undefined);
        await this.recoverEntry(alias);

        const tempSecretName = `.secret-${randomUUID()}.tmp`;
        const tempMetaName = `.meta-${randomUUID()}.tmp`;
        const backupSecretName = `.secret-${randomUUID()}.bak`;
        const backupMetaName = `.meta-${randomUUID()}.bak`;
        const tempSecret = path.join(entry.dir, tempSecretName);
        const tempMeta = path.join(entry.dir, tempMetaName);
        const backupSecret = path.join(entry.dir, backupSecretName);
        const backupMeta = path.join(entry.dir, backupMetaName);
        let bytes = 0;
        let updatedAt = new Date().toISOString();

        try {
          const file = await open(tempSecret, "wx", 0o600);
          try {
            for await (const chunk of chunks) {
              if (!Buffer.isBuffer(chunk)) throw new Error("Secret chunk must be a Buffer");
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                if (bytesWritten <= 0) throw new Error("Secret write made no progress");
                offset += bytesWritten;
                bytes += bytesWritten;
              }
            }
            await file.sync();
          } finally {
            await file.close();
          }
          await chmod(tempSecret, 0o600).catch(() => undefined);
          const stagedSecret = await stat(tempSecret);
          if (stagedSecret.size !== bytes) {
            throw new Error(`Secret staging size mismatch: expected ${bytes}, got ${stagedSecret.size}`);
          }
          updatedAt = new Date().toISOString();
          await writeFile(tempMeta, `${JSON.stringify({ alias, bytes, updatedAt } satisfies StoredMeta)}\n`, { mode: 0o600 });
          await syncFile(tempMeta);
        } catch (error) {
          await rm(tempSecret, { force: true }).catch(() => undefined);
          await rm(tempMeta, { force: true }).catch(() => undefined);
          throw error;
        }

        const hadSecret = await exists(entry.secret);
        const hadMeta = await exists(entry.meta);
        if (hadSecret !== hadMeta) {
          await rm(tempSecret, { force: true });
          await rm(tempMeta, { force: true });
          throw new Error(`Secret alias ${alias} storage is inconsistent`);
        }

        const transaction: ReplacementTxn = {
          version: 1, alias, tempSecret: tempSecretName, tempMeta: tempMetaName,
          backupSecret: backupSecretName, backupMeta: backupMetaName, hadSecret, hadMeta,
        };
        try {
          await this.writeTransaction(entry, transaction);
        } catch (error) {
          if (await exists(entry.transaction)) {
            try { await this.recoverEntry(alias); }
            catch (recoveryError) {
              throw new AggregateError([error, recoveryError], `Secret alias ${alias} journal creation and recovery both failed`);
            }
          } else {
            await rm(tempSecret, { force: true }).catch(() => undefined);
            await rm(tempMeta, { force: true }).catch(() => undefined);
          }
          throw error;
        }

        try {
          if (hadSecret) await rename(entry.secret, backupSecret);
          if (hadMeta) await rename(entry.meta, backupMeta);
          await rename(tempSecret, entry.secret);
          await rename(tempMeta, entry.meta);
          await syncDirectory(entry.dir);
          await rm(backupSecret, { force: true });
          await rm(backupMeta, { force: true });
          await rm(entry.transaction, { force: true });
          await syncDirectory(entry.dir);
        } catch (error) {
          try { await this.recoverEntry(alias); }
          catch (recoveryError) {
            throw new AggregateError([error, recoveryError], `Secret alias ${alias} replacement and recovery both failed`);
          }
          throw error;
        }
        return { alias, present: true, bytes, updatedAt };
    });
  }

  async delete(alias: string): Promise<{ alias: string; deleted: boolean }> {
    return this.withAliasLock(alias, async () => {
      await this.recoverEntry(alias);
      const entry = this.entry(alias);
      try {
        await rm(entry.dir, { recursive: true, force: false });
        await syncDirectory(this.root);
        return { alias, deleted: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { alias, deleted: false };
        throw error;
      }
    });
  }
}
