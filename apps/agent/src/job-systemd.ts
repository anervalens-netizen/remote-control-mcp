import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
const properties = ["Type=exec", "KillMode=control-group", "SendSIGKILL=yes", "TimeoutStopSec=2s", "Restart=no", "StandardOutput=null", "StandardError=null"];
const propertyArgs = properties.flatMap(value => ["--property", value]);
let capability: { ready: boolean; reason: string } | undefined;

export function jobSystemdManagerScope(uid = typeof process.getuid === "function" ? process.getuid() : null, platform = process.platform): "user" | "system" | "unsupported" {
  if (platform !== "linux") return "unsupported";
  return uid === 0 ? "system" : "user";
}
function managerArgs(): string[] {
  return jobSystemdManagerScope() === "system" ? [] : ["--user"];
}

export function jobUnitName(id: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid job unit identity");
  return `rcmcp-job-${id}.service`;
}

/** Probe actual transient-service admission, not just presence of a binary/bus.
 * A failed job admission never falls back to spawn (it may already have effects). */
export function jobCgroupIsolation() {
  if (process.platform !== "linux") return { ready: false, reason: "unsupported_platform" };
  if (process.env.RCMCP_JOB_CGROUP_ISOLATION === "0") return { ready: false, reason: "disabled" };
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) return { ready: false, reason: "cgroup_v2_unavailable" };
  if (!capability) {
    const scope = jobSystemdManagerScope();
    const probe = spawnSync("systemd-run", [...managerArgs(), "--quiet", "--expand-environment=no", "--wait", "--collect", "--unit", jobUnitName(randomUUID()), ...propertyArgs, "--", "/bin/true"], {
      stdio: "ignore", timeout: 5000,
    });
    capability = { ready: probe.status === 0, reason: probe.status === 0 ? "systemd_" + scope + "_service" : "systemd_" + scope + "_unavailable" };
  }
  return capability;
}

export async function admitJobUnit(id: string, launcher: string, payload: string): Promise<void> {
  try {
    await exec("systemd-run", [...managerArgs(), "--quiet", "--expand-environment=no", "--collect", "--unit", jobUnitName(id), ...propertyArgs,
      "--property", "RemainAfterExit=yes", "--description", `RCMCP durable job ${id}`,
      "--", process.execPath, launcher, payload], { timeout: 10_000, maxBuffer: 4096 });
  } catch {
    // Never return systemd stderr/argv/env; admission failure can be ambiguous.
    throw new Error("Job service admission failed or is uncertain; inspect the reserved job");
  }
}

export type JobUnit = { active: string; sub: string; pid: number; invocation: string; cgroup: string };
export type JobUnitCleanupInspection = { state: "present"; unit: JobUnit } | { state: "absent" } | { state: "unknown" };
function inspectionArgs(id: string) {
  return [...managerArgs(), "show", jobUnitName(id), "--property=LoadState,ActiveState,SubState,MainPID,ExecMainPID,InvocationID,ControlGroup,Description,Transient"];
}
function parseUnit(id: string, output: string): JobUnit | null {
  const p = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
  if (p.LoadState !== "loaded" || p.Transient !== "yes" || p.Description !== `RCMCP durable job ${id}`) return null;
  return { active: p.ActiveState!, sub: p.SubState!, pid: Number(p.MainPID) || Number(p.ExecMainPID) || 0, invocation: p.InvocationID ?? "", cgroup: p.ControlGroup ?? "" };
}
export function inspectJobUnit(id: string): JobUnit | null {
  if (process.platform !== "linux") return null;
  const result = spawnSync("systemctl", inspectionArgs(id),
  { encoding: "utf8", timeout: 2000, maxBuffer: 8192 });
  if (result.status !== 0) return null;
  return parseUnit(id, result.stdout);
}
export async function inspectJobUnitAsync(id: string): Promise<JobUnit | null> {
  if (process.platform !== "linux") return null;
  try { return parseUnit(id, (await exec("systemctl", inspectionArgs(id), { timeout: 2000, maxBuffer: 8192 })).stdout); }
  catch { return null; }
}

/** Cleanup needs to distinguish a confirmed missing unit from a transient bus
 * or permission error. Ordinary reconciliation intentionally retains its
 * historical nullable contract. */
export async function inspectJobUnitForCleanup(id: string): Promise<JobUnitCleanupInspection> {
  if (process.platform !== "linux") return { state: "unknown" };
  let output = "";
  try { output = (await exec("systemctl", inspectionArgs(id), { timeout: 2000, maxBuffer: 8192 })).stdout; }
  catch (error) { output = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : ""; }
  const unit = output ? parseUnit(id, output) : null;
  if (unit) return { state: "present", unit };
  if (/^LoadState=not-found$/m.test(output)) return { state: "absent" };
  return { state: "unknown" };
}

/** cgroup.events includes nested cgroups. Absence is useful only after durable
 * evidence of admission; it must never turn a reservation into not-started. */
export function jobCgroupEmpty(id: string, cgroup: string): boolean | null {
  if (!cgroup.startsWith("/") || cgroup.split("/").includes("..") || !cgroup.endsWith("/" + jobUnitName(id))) return null;
  try { return /^populated 0$/m.test(readFileSync("/sys/fs/cgroup" + cgroup + "/cgroup.events", "utf8")); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? true : null; }
}

export async function stopJobUnit(id: string): Promise<boolean> {
  try { await exec("systemctl", [...managerArgs(), "stop", jobUnitName(id)], { timeout: 10_000, maxBuffer: 4096 }); return true; }
  catch { return false; }
}

export async function releaseJobUnit(id: string): Promise<void> {
  await stopJobUnit(id);
  try { await exec("systemctl", [...managerArgs(), "reset-failed", jobUnitName(id)], { timeout: 2000, maxBuffer: 4096 }); } catch { /* already collected */ }
}

// Copied into immutable private state: no dependency on a mutable release tree.
// execve preserves MainPID/identity and passes command/env only through private
// state/environment. The shell opens append-only output files itself.
export const systemdLauncherContent = `import { readFileSync, openSync, closeSync, fsyncSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.chdir(p.cwd);
const stat = readFileSync('/proc/self/stat', 'utf8');
const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const cgroup = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\\n').find(x => x.startsWith('0::'))?.slice(3);
if (!cgroup || !cgroup.endsWith('/rcmcp-job-' + p.id + '.service')) process.exit(125);
const receipt = { id: p.id, pid: process.pid, processIdentity: 'linux:' + boot + ':' + ticks, cgroup };
const tmp = p.receipt + '.tmp';
writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
const fd = openSync(tmp, 'r+'); fsyncSync(fd); closeSync(fd);
renameSync(tmp, p.receipt);
const dir = openSync(path.dirname(p.receipt), 'r'); fsyncSync(dir); closeSync(dir);
process.execve('/bin/bash', ['/bin/bash', p.runner], p.env);
`;
