import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import process from "node:process";
import { promisify } from "node:util";
import { runtimeEnv } from "./runtime-env.ts";
import { runProcess } from "./exec.ts";

const execFileAsync = promisify(execFile);
async function run(file: string, args: string[], maxBuffer = 32 * 1024 * 1024) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { env: runtimeEnv(), windowsHide: true, maxBuffer });
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    return { ok: false, code: typeof error?.code === "number" ? error.code : null, stdout: error?.stdout?.toString?.().trim?.() ?? "", stderr: error?.stderr?.toString?.().trim?.() ?? error?.message ?? String(error) };
  }
}
async function psJson(script: string) {
  const result = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
  if (!result.ok) throw new Error(result.stderr || "PowerShell failed");
  return result.stdout ? JSON.parse(result.stdout) : null;
}
async function tailscaleStatus() {
  const result = await run("tailscale", ["status", "--json"], 16 * 1024 * 1024);
  if (!result.ok || !result.stdout) return null;
  try { return JSON.parse(result.stdout); } catch { return { raw: result.stdout }; }
}

export async function networkSnapshot() {
  if (process.platform === "win32") {
    const data = await psJson(`$a=@(Get-NetIPConfiguration|ForEach-Object{[pscustomobject]@{alias=$_.InterfaceAlias;index=$_.InterfaceIndex;ipv4=@($_.IPv4Address.IPAddress);ipv6=@($_.IPv6Address.IPAddress);gateway=@($_.IPv4DefaultGateway.NextHop);dns=@($_.DNSServer.ServerAddresses)}}); $r=@(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue|Sort-Object RouteMetric|Select-Object -First 100 DestinationPrefix,NextHop,RouteMetric,InterfaceIndex); $l=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Select-Object LocalAddress,LocalPort,OwningProcess|Sort-Object LocalPort); [pscustomobject]@{adapters=$a;routes=$r;tcpListeners=$l}|ConvertTo-Json -Compress -Depth 6`);
    return { hostname: os.hostname(), platform: process.platform, ...data as object, tailscale: await tailscaleStatus() };
  }
  const [addresses, routes, listeners, dns, tailscale] = await Promise.all([
    run("ip", ["-j", "address"]), run("ip", ["-j", "route"]), run("ss", ["-H", "-lntup"]),
    readFile("/etc/resolv.conf", "utf8").catch(() => ""), tailscaleStatus(),
  ]);
  return {
    hostname: os.hostname(), platform: process.platform,
    addresses: addresses.ok && addresses.stdout ? JSON.parse(addresses.stdout) : [],
    routes: routes.ok && routes.stdout ? JSON.parse(routes.stdout) : [],
    listeners: listeners.stdout.split(/\r?\n/).filter(Boolean),
    dns: dns.split(/\r?\n/).filter((line) => /^\s*(nameserver|search|domain)\b/.test(line)), tailscale,
  };
}

export async function storageSnapshot() {
  if (process.platform === "win32") {
    return psJson(`$d=@(Get-CimInstance Win32_DiskDrive|Select-Object DeviceID,Model,SerialNumber,Size,InterfaceType,MediaType); $v=@(Get-CimInstance Win32_LogicalDisk|Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace); [pscustomobject]@{disks=$d;volumes=$v}|ConvertTo-Json -Compress -Depth 5`);
  }
  const result = await run("lsblk", ["-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINTS,MODEL,SERIAL,ROTA,TRAN"]);
  return result.ok && result.stdout ? JSON.parse(result.stdout) : { blockdevices: [], error: result.stderr };
}

export async function gpuSnapshot() {
  if (process.platform === "win32") {
    return psJson(`$g=@(Get-CimInstance Win32_VideoController|Select-Object Name,AdapterRAM,DriverVersion,VideoProcessor,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,PNPDeviceID); $e=@(); try{$e=@((Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples|Where-Object{$_.CookedValue -gt 0}|Sort-Object CookedValue -Descending|Select-Object -First 20 InstanceName,CookedValue)}catch{}; [pscustomobject]@{controllers=$g;activeEngines=$e}|ConvertTo-Json -Compress -Depth 5`);
  }
  const nvidia = await run("nvidia-smi", ["--query-gpu=name,driver_version,temperature.gpu,utilization.gpu,memory.total,memory.used,power.draw", "--format=csv,noheader,nounits"]);
  if (nvidia.ok) return { backend: "nvidia-smi", lines: nvidia.stdout.split(/\r?\n/).filter(Boolean) };
  const rocm = await run("rocm-smi", ["--showproductname", "--showuse", "--showmemuse", "--showtemp", "--json"]);
  if (rocm.ok && rocm.stdout) { try { return { backend: "rocm-smi", data: JSON.parse(rocm.stdout) }; } catch { return { backend: "rocm-smi", raw: rocm.stdout }; } }
  const pci = await run("lspci", []);
  return { backend: "pci", controllers: pci.stdout.split(/\r?\n/).filter((line: string) => /vga|3d|display/i.test(line)) };
}

export async function packageManagers() {
  const candidates = process.platform === "win32" ? ["winget", "choco", "scoop"] : ["apt-get", "dnf", "yum", "pacman", "zypper", "brew"];
  const found: string[] = [];
  for (const name of candidates) {
    const probe = process.platform === "win32" ? await run("where.exe", [name]) : await run("sh", ["-lc", `command -v ${name}`]);
    if (probe.ok) found.push(name);
  }
  return { platform: process.platform, managers: found };
}

type PackageAction = "list" | "search" | "install" | "upgrade" | "remove";
export function buildPackageCommand(manager: string, action: PackageAction, pkgs: string[], all = false): { file: string; args: string[] } {
  if (pkgs.length && all) throw new Error("Specify packages or all=true, not both");
  let file = manager; let args: string[] = [];
  if (manager === "apt-get") {
    if (action === "list") { file = "dpkg-query"; args = ["-W", "-f=${binary:Package}\t${Version}\n"]; }
    else if (action === "search") { file = "apt-cache"; args = ["search", ...pkgs]; }
    else if (action === "install") {
      if (!pkgs.length) throw new Error("apt-get install requires at least one package");
      args = ["install", "-y", ...pkgs];
    } else if (action === "upgrade") {
      if (pkgs.length) args = ["install", "--only-upgrade", "-y", ...pkgs];
      else if (all) args = ["upgrade", "-y"];
      else throw new Error("apt-get upgrade without packages requires all=true");
    } else {
      if (!pkgs.length) throw new Error("apt-get remove requires at least one package; use exec for custom global operations");
      args = ["remove", "-y", ...pkgs];
    }
  } else if (manager === "winget") {
    if (action === "list") args = ["list", "--accept-source-agreements"];
    else if (action === "search") args = ["search", ...pkgs, "--accept-source-agreements"];
    else if (action === "upgrade" && pkgs.length === 0) {
      if (!all) throw new Error("winget upgrade without packages requires all=true");
      args = ["upgrade", "--all", "--accept-source-agreements", "--accept-package-agreements"];
    } else {
      const verb = action === "remove" ? "uninstall" : action;
      if (pkgs.length !== 1) throw new Error(`${manager} ${action} requires exactly one package`);
      args = [verb, "--id", pkgs[0]!, "--exact", "--accept-source-agreements", ...(verb === "install" || verb === "upgrade" ? ["--accept-package-agreements"] : [])];
    }
  } else if (manager === "choco") {
    if (action === "list") args = ["list"];
    else if (action === "search") args = ["search", ...pkgs];
    else {
      if (!pkgs.length && !all) throw new Error(`choco ${action} without packages requires all=true`);
      if (action === "install" && all) throw new Error("choco install all is not supported by the high-level tool; use exec for a custom command");
      args = [action === "remove" ? "uninstall" : action, ...(pkgs.length ? pkgs : ["all"]), "-y"];
    }
  } else throw new Error(`High-level package actions not implemented for ${manager}; use exec for unrestricted access`);
  return { file, args };
}

export function packageOperationOk(result: { code: number | null; timedOut: boolean }): boolean {
  return result.code === 0 && !result.timedOut;
}

export async function packageManage(input: { manager?: string; action: PackageAction; packages?: string[]; all?: boolean; timeoutMs?: number }) {
  const available = (await packageManagers()).managers;
  const manager = input.manager && input.manager !== "auto" ? input.manager : available[0];
  if (!manager || !available.includes(manager)) throw new Error(`Package manager unavailable: ${manager ?? "auto"}`);
  const pkgs = input.packages ?? [];
  const { file, args } = buildPackageCommand(manager, input.action, pkgs, input.all ?? false);
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;
  const result = await runProcess(file, args, { timeoutMs, maxOutputBytes: 32 * 1024 * 1024 });
  const limit = 1024 * 1024;
  return {
    manager, action: input.action, packages: pkgs, all: input.all ?? false, timeoutMs,
    ok: packageOperationOk(result), ...result,
    stdout: result.stdout.slice(0, limit), stderr: result.stderr.slice(0, limit),
    stdoutTruncated: result.stdoutBytes > limit, stderrTruncated: result.stderrBytes > limit,
  };
}

export { hostPower } from "./power.ts";
