import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type Scope = "user" | "system";
type ServiceAction = "status" | "start" | "stop" | "restart" | "enable" | "disable";

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function powershellJson(script: string, timeoutMs?: number): Promise<unknown> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], {
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function linuxServiceStatus(name: string, scope: Scope) {
  const args = [...(scope === "user" ? ["--user"] : []), "show", name, "--no-page",
    "--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus"];
  const { stdout } = await execFileAsync("systemctl", args, { maxBuffer: 4 * 1024 * 1024 });
  return Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function windowsServiceStatus(name: string) {
  const q = psLiteral(name);
  const script = `$s = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq ${q} } | Select-Object Name,DisplayName,State,Status,StartMode,ProcessId,PathName; if ($null -eq $s) { throw 'Service not found' }; $s | ConvertTo-Json -Compress`;
  return powershellJson(script);
}

export async function serviceManage(input: { name: string; action: ServiceAction; scope?: Scope }) {
  if (process.platform === "win32") {
    const q = psLiteral(input.name);
    const actions: Record<Exclude<ServiceAction, "status">, string> = {
      start: `Start-Service -Name ${q}`,
      stop: `Stop-Service -Name ${q}`,
      restart: `Restart-Service -Name ${q}`,
      enable: `Set-Service -Name ${q} -StartupType Automatic`,
      disable: `Set-Service -Name ${q} -StartupType Disabled`,
    };
    if (input.action !== "status") {
      await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", actions[input.action]], { maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    }
    return windowsServiceStatus(input.name);
  }

  const scope = input.scope ?? "system";
  if (input.action !== "status") {
    const args = [...(scope === "user" ? ["--user"] : []), input.action, input.name];
    await execFileAsync("systemctl", args, { maxBuffer: 4 * 1024 * 1024 });
  }
  return linuxServiceStatus(input.name, scope);
}

export async function serviceLogs(input: { name: string; scope?: Scope; lines?: number }) {
  const limit = Math.max(1, Math.min(input.lines ?? 100, 1000));
  if (process.platform === "win32") {
    const q = psLiteral(input.name);
    const script = `$n=${limit}; $name=${q}; $e=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager'} -MaxEvents 2000 -ErrorAction SilentlyContinue | Where-Object { $_.Message -like ('*' + $name + '*') } | Select-Object -First $n TimeCreated,Id,LevelDisplayName,Message); ConvertTo-Json -InputObject $e -Compress -Depth 4`;
    const events = await powershellJson(script);
    return { name: input.name, scope: "system", events: Array.isArray(events) ? events : events ? [events] : [] };
  }

  const scope = input.scope ?? "system";
  const args = scope === "user"
    ? ["--user-unit", input.name, "-n", String(limit), "--no-pager", "-o", "short-iso"]
    : ["-u", input.name, "-n", String(limit), "--no-pager", "-o", "short-iso"];
  const { stdout } = await execFileAsync("journalctl", args, { maxBuffer: 16 * 1024 * 1024 });
  return { name: input.name, scope, lines: stdout.split("\n").filter(Boolean) };
}

type FilesystemRecord = Record<string, unknown>;
type FilesystemSnapshot = {
  filesystems: FilesystemRecord[];
  warnings: string[];
  sampledAt: string;
  sampledAtMs: number;
};

const FILESYSTEM_CACHE_MS = 1000;
const COLLECTOR_TIMEOUT_MS = 1500;
const filesystemCache = new Map<string, FilesystemSnapshot>();
const filesystemPending = new Map<string, Promise<FilesystemSnapshot>>();

function rootMount(): string {
  return process.platform === "win32" ? (process.env.SystemDrive || "C:") : "/";
}

function rootPath(): string {
  const root = rootMount();
  return process.platform === "win32" ? `${root}\\` : root;
}

export function diskUsage(sizeBytes: number, usedBytes: number, availableBytes: number): string | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isFinite(usedBytes) || usedBytes < 0 || !Number.isFinite(availableBytes) || availableBytes < 0) return null;
  const denominator = usedBytes + availableBytes;
  if (denominator <= 0) return null;
  return `${Math.min(100, Math.max(0, Math.round(usedBytes / denominator * 100)))}%`;
}

export function parseDfMetrics(stdout: string): FilesystemRecord[] {
  return stdout.split("\n").slice(1).filter(Boolean).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7 || !parts.slice(2, 5).every((value) => Number.isFinite(Number(value)))) return [];
    return [{
      source: parts[0], type: parts[1], sizeBytes: Number(parts[2]), usedBytes: Number(parts[3]),
      availableBytes: Number(parts[4]), usedPercent: parts[5], mount: parts.slice(6).join(" "),
    }];
  });
}

async function collectRootFilesystem(): Promise<FilesystemSnapshot> {
  const sampledAtMs = Date.now();
  const warnings: string[] = [];
  const mount = rootMount();
  try {
    const value = await statfs(rootPath());
    const sizeBytes = value.blocks * value.bsize;
    const usedBytes = (value.blocks - value.bfree) * value.bsize;
    const availableBytes = value.bavail * value.bsize;
    return {
      filesystems: [{
        source: mount, type: null, sizeBytes, usedBytes, availableBytes,
        usedPercent: diskUsage(sizeBytes, usedBytes, availableBytes), mount,
        collector: "native-statfs",
      }],
      warnings,
      sampledAt: new Date(sampledAtMs).toISOString(),
      sampledAtMs,
    };
  } catch (error) {
    const kind = error instanceof Error && error.message === "filesystem_probe_timeout" ? "filesystem_probe_timeout" : "filesystem_probe_unavailable";
    warnings.push(kind);
    return { filesystems: [], warnings, sampledAt: new Date(sampledAtMs).toISOString(), sampledAtMs };
  }
}

async function collectFullFilesystems(): Promise<FilesystemSnapshot> {
  const sampledAtMs = Date.now();
  const warnings: string[] = [];
  let filesystems: FilesystemRecord[] = [];
  if (process.platform === "win32") {
    try {
      const raw = await powershellJson("$d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FileSystem,Size,FreeSpace,VolumeName); ConvertTo-Json -InputObject $d -Compress", COLLECTOR_TIMEOUT_MS);
      const disks = Array.isArray(raw) ? raw : raw ? [raw] : [];
      filesystems = disks.map((disk: any) => {
        const sizeBytes = Number(disk.Size ?? 0);
        const availableBytes = Number(disk.FreeSpace ?? 0);
        const usedBytes = Math.max(0, sizeBytes - availableBytes);
        return {
          source: disk.DeviceID, type: disk.FileSystem ?? null, sizeBytes, usedBytes, availableBytes,
          usedPercent: diskUsage(sizeBytes, usedBytes, availableBytes), volume: disk.VolumeName ?? null, mount: disk.DeviceID,
        };
      });
    } catch (error) {
      warnings.push((error as NodeJS.ErrnoException & { killed?: boolean }).killed ? "filesystem_probe_timeout" : "filesystem_probe_unavailable");
    }
  } else {
    try {
      const { stdout } = await execFileAsync("df", ["-B1", "--output=source,fstype,size,used,avail,pcent,target"], {
        maxBuffer: 8 * 1024 * 1024,
        timeout: COLLECTOR_TIMEOUT_MS,
      });
      filesystems = parseDfMetrics(stdout);
    } catch (error) {
      const partial = error as NodeJS.ErrnoException & { stdout?: string | Buffer; killed?: boolean };
      const stdout = typeof partial.stdout === "string" ? partial.stdout : Buffer.isBuffer(partial.stdout) ? partial.stdout.toString("utf8") : "";
      filesystems = parseDfMetrics(stdout);
      warnings.push(partial.killed ? "filesystem_probe_timeout" : "filesystem_probe_partial_failure");
    }
  }
  if (filesystems.length === 0 && warnings.length === 0) warnings.push("filesystem_probe_empty");
  return { filesystems, warnings, sampledAt: new Date(sampledAtMs).toISOString(), sampledAtMs };
}

async function filesystemMetrics(profile: "light" | "full"): Promise<{ snapshot: FilesystemSnapshot; cached: boolean }> {
  const key = `${profile}:${rootMount()}`;
  const now = Date.now();
  const cached = filesystemCache.get(key);
  if (cached && now - cached.sampledAtMs < FILESYSTEM_CACHE_MS) return { snapshot: cached, cached: true };
  let pending = filesystemPending.get(key);
  const joined = Boolean(pending);
  if (!pending) {
    pending = (profile === "light" ? collectRootFilesystem() : collectFullFilesystems())
      .then((snapshot) => {
        if (snapshot.filesystems.length > 0 || snapshot.warnings.length === 0) filesystemCache.set(key, snapshot);
        return snapshot;
      })
      .finally(() => filesystemPending.delete(key));
    filesystemPending.set(key, pending);
  }
  if (profile === "full") return { snapshot: await pending, cached: joined };
  // statfs cannot be cancelled. Keep the raw operation in the shared map until
  // it settles; only the caller's wait is bounded, preventing thread-pool floods.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      pending,
      new Promise<FilesystemSnapshot>((resolve) => {
        timer = setTimeout(() => {
          const sampledAtMs = Date.now();
          resolve({ filesystems: [], warnings: ["filesystem_probe_timeout"], sampledAt: new Date(sampledAtMs).toISOString(), sampledAtMs });
        }, COLLECTOR_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return { snapshot, cached: joined };
  } finally { if (timer) clearTimeout(timer); }
}

export type LightSystemMetrics = {
  profile: "light";
  hostname: string;
  platform: NodeJS.Platform;
  arch: string;
  uptimeSeconds: number;
  loadAverage: number[];
  cpuCount: number;
  cpuModel: string | null;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  rootFilesystem: FilesystemRecord | null;
  observedAt: string;
  filesystemSampledAt: string;
  filesystemAgeMs: number;
  filesystemCached: boolean;
  metricsStatus: "ok" | "partial";
  warnings: string[];
};
export type FullSystemMetrics = Omit<LightSystemMetrics, "profile"> & {
  profile: "full";
  networkInterfaces: ReturnType<typeof os.networkInterfaces>;
  filesystems: FilesystemRecord[];
};

export async function systemMetrics(profile: "light"): Promise<LightSystemMetrics>;
export async function systemMetrics(profile?: "full"): Promise<FullSystemMetrics>;
export async function systemMetrics(profile: "light" | "full" = "full"): Promise<LightSystemMetrics | FullSystemMetrics> {
  const { snapshot, cached } = await filesystemMetrics(profile);
  const root = rootMount();
  const rootFilesystem = snapshot.filesystems.find((item) => item.mount === root || item.mount === rootPath()) ?? null;
  const warnings = rootFilesystem ? [...snapshot.warnings] : [...snapshot.warnings, "root_filesystem_unavailable"];
  const base = {
    profile,
    hostname: os.hostname(), platform: process.platform, arch: process.arch,
    uptimeSeconds: Math.floor(os.uptime()), loadAverage: os.loadavg(),
    cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    rootFilesystem,
    observedAt: new Date().toISOString(),
    filesystemSampledAt: snapshot.sampledAt,
    filesystemAgeMs: Math.max(0, Date.now() - snapshot.sampledAtMs),
    filesystemCached: cached,
    metricsStatus: warnings.length ? "partial" as const : "ok" as const,
    warnings,
  };
  if (profile === "light") return { ...base, profile: "light" as const };
  return { ...base, profile: "full" as const, networkInterfaces: os.networkInterfaces(), filesystems: snapshot.filesystems };
}
