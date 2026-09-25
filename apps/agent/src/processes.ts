import { filterProcesses } from "../../../packages/protocol/src/filtering.ts";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { runtimeEnv } from "./runtime-env.ts";

const execFileAsync = promisify(execFile);

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawned = false;
    const onSpawn = () => { spawned = true; child.off("spawn", onSpawn); resolve(); };
    const onError = (error: Error) => { if (!spawned) { child.off("spawn", onSpawn); reject(error); } };
    child.once("spawn", onSpawn);
    child.on("error", onError);
  });
}

export async function listProcesses() {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { maxBuffer: 32 * 1024 * 1024 });
    const value = JSON.parse(stdout || "[]");
    return Array.isArray(value) ? value : [value];
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,user=,stat=,%cpu=,%mem=,etimes=,comm=,args="], { maxBuffer: 32 * 1024 * 1024 });
  return stdout.split("\n").filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s?(.*)$/);
    if (!match) return { raw: line };
    return {
      pid: Number(match[1]), ppid: Number(match[2]), user: match[3], state: match[4],
      cpuPercent: Number(match[5]), memoryPercent: Number(match[6]), elapsedSeconds: Number(match[7]),
      command: match[8], args: match[9] ?? "",
    };
  });
}
export async function findProcesses(input: { query?: string; pid?: number; limit?: number }) {
  return filterProcesses(await listProcesses() as Array<Record<string, unknown>>, input);
}
export function killProcess(pid: number, signal: NodeJS.Signals | number = "SIGTERM") {
  try {
    process.kill(pid, signal);
    return { ok: true, pid, signal, alreadyExited: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { ok: true, pid, signal, alreadyExited: true };
    throw error;
  }
}

export async function startProcess(input: { command: string; cwd?: string; env?: Record<string, string> }) {
  const windows = process.platform === "win32";
  const file = windows ? "powershell.exe" : "/bin/bash";
  const args = windows
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command]
    : ["-lc", input.command];
  const child = spawn(file, args, {
    cwd: input.cwd, env: runtimeEnv(input.env),
    detached: !windows, stdio: "ignore", windowsHide: true,
  });
  await waitForSpawn(child);
  if (!child.pid) throw new Error("Process started without a PID");
  // Keep an error listener for the detached lifetime so a late child-process
  // error cannot become an unhandled EventEmitter error in the agent.
  child.on("error", () => undefined);
  child.unref();
  return { pid: child.pid, command: input.command, cwd: input.cwd ?? null, detached: true };
}
