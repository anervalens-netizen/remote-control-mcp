import { execFile } from "node:child_process";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type Scope = "user" | "system";
type ServiceAction = "status" | "start" | "stop" | "restart" | "enable" | "disable";

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function powershellJson(script: string): Promise<unknown> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script,
  ], { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
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

async function filesystemMetrics(): Promise<unknown[]> {
  if (process.platform === "win32") {
    const raw = await powershellJson("$d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FileSystem,Size,FreeSpace,VolumeName); ConvertTo-Json -InputObject $d -Compress");
    const disks = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return disks.map((disk: any) => ({
      source: disk.DeviceID, type: disk.FileSystem ?? null,
      sizeBytes: Number(disk.Size ?? 0), usedBytes: Number(disk.Size ?? 0) - Number(disk.FreeSpace ?? 0),
      availableBytes: Number(disk.FreeSpace ?? 0), volume: disk.VolumeName ?? null, mount: disk.DeviceID,
    }));
  }

  const { stdout } = await execFileAsync("df", ["-B1", "--output=source,fstype,size,used,avail,pcent,target"], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.split("\n").slice(1).filter(Boolean).map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      source: parts[0], type: parts[1], sizeBytes: Number(parts[2]), usedBytes: Number(parts[3]),
      availableBytes: Number(parts[4]), usedPercent: parts[5], mount: parts.slice(6).join(" "),
    };
  });
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
  rootFilesystem: Record<string, unknown> | null;
};
export type FullSystemMetrics = Omit<LightSystemMetrics, "profile"> & {
  profile: "full";
  networkInterfaces: ReturnType<typeof os.networkInterfaces>;
  filesystems: Array<Record<string, unknown>>;
};

export async function systemMetrics(profile: "light"): Promise<LightSystemMetrics>;
export async function systemMetrics(profile?: "full"): Promise<FullSystemMetrics>;
export async function systemMetrics(profile: "light" | "full" = "full"): Promise<LightSystemMetrics | FullSystemMetrics> {
  const filesystems = await filesystemMetrics() as Array<Record<string, unknown>>;
  const rootFilesystem = filesystems.find((item) => item.mount === "/" || item.mount === "C:" || item.mount === "C:\\") ?? null;
  const base = {
    profile,
    hostname: os.hostname(), platform: process.platform, arch: process.arch,
    uptimeSeconds: Math.floor(os.uptime()), loadAverage: os.loadavg(),
    cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null,
    totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(),
    rootFilesystem,
  };
  if (profile === "light") return { ...base, profile: "light" as const };
  return { ...base, profile: "full" as const, networkInterfaces: os.networkInterfaces(), filesystems };
}
