import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

const TRACKER_TIMEOUT_MS = 2_000;
// Background attachment may cold-start the native compiler on hosted Windows.
// Cancellation still waits at most 250ms before the identity-bound fallback.
const TRACKER_STARTUP_TIMEOUT_MS = 8_000;

// Assignment happens after the caller has started the root, so the job covers
// the root and descendants created after assignment, not descendants that
// escaped before the attach completed. That scope is deliberately reported as
// partial; it is never promoted to a whole-tree verification claim.
const trackerScript = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RcmcpJobObject {
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BASIC_LIMITS {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct EXTENDED_LIMITS {
    public BASIC_LIMITS BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ACCOUNTING {
    public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS info, uint length);
  public static bool PreserveExplicitBreakaway(IntPtr job) {
    var limits = new EXTENDED_LIMITS();
    // Membership tracking must not forbid a caller's explicit child breakaway.
    limits.BasicLimitInformation.LimitFlags = 0x00000800; // JOB_OBJECT_LIMIT_BREAKAWAY_OK
    return SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits));
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref ACCOUNTING info, uint length, out uint returned);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
  public const uint ProcessTerminate = 0x0001;
  public const uint ProcessSetQuota = 0x0100;
  public const uint ProcessQueryLimitedInformation = 0x1000;
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static System.Threading.Tasks.Task<string> ReadCommand() { return System.Threading.Tasks.Task.Run(() => Console.ReadLine()); }
  public const uint ProcessAccess = ProcessTerminate | ProcessSetQuota | ProcessQueryLimitedInformation | 0x00100000;
  public static string Identity(IntPtr process) {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new Exception("GetProcessTimes failed: " + GetLastError());
    return "win:" + (creation + 504911232000000000L).ToString();
  }
  public static int ActiveMembers(IntPtr job) {
    var info = new ACCOUNTING();
    uint returned;
    if (!QueryInformationJobObject(job, 1, ref info, (uint)Marshal.SizeOf(info), out returned)) return -1;
    return (int)info.ActiveProcesses;
  }
}
'@

$job = [RcmcpJobObject]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed: ' + [RcmcpJobObject]::GetLastError() }
if (-not [RcmcpJobObject]::PreserveExplicitBreakaway($job)) {
  $nativeError = [RcmcpJobObject]::GetLastError()
  [RcmcpJobObject]::CloseHandle($job) | Out-Null
  throw 'Job capability preservation failed: ' + $nativeError
}
$target = [RcmcpJobObject]::OpenProcess([RcmcpJobObject]::ProcessAccess, $false, [uint32]$env:RCMCP_TRACK_PID)
if ($target -eq [IntPtr]::Zero) {
  [RcmcpJobObject]::CloseHandle($job) | Out-Null
  throw 'OpenProcess failed: ' + [RcmcpJobObject]::GetLastError()
}
try {
  $observedIdentity = [RcmcpJobObject]::Identity($target)
  if ($observedIdentity -ne $env:RCMCP_TRACK_IDENTITY) { throw 'Process identity mismatch before assignment' }
  if (-not [RcmcpJobObject]::AssignProcessToJobObject($job, $target)) { throw 'AssignProcessToJobObject failed: ' + [RcmcpJobObject]::GetLastError() }
} catch {
  [RcmcpJobObject]::CloseHandle($target) | Out-Null
  [RcmcpJobObject]::CloseHandle($job) | Out-Null
  throw
}
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$pendingCommand = [RcmcpJobObject]::ReadCommand()
while (-not $pendingCommand.IsCompleted) {
  if ($target -ne [IntPtr]::Zero -and [RcmcpJobObject]::WaitForSingleObject($target, 0) -eq 0) {
    [RcmcpJobObject]::CloseHandle($target) | Out-Null
    $target = [IntPtr]::Zero
  }
  if ($target -eq [IntPtr]::Zero -and [RcmcpJobObject]::ActiveMembers($job) -eq 0) { break }
  Start-Sleep -Milliseconds 40
}
$command = if ($pendingCommand.IsCompleted) { $pendingCommand.GetAwaiter().GetResult() } else { 'close' }
if ($command -eq 'terminate') {
  # Preserve the parent chain while taskkill discovers pre-attachment children.
  # The verified process handle is retained until this numeric-PID use ends.
  if ($target -ne [IntPtr]::Zero) {
    $savedErrorAction = $ErrorActionPreference
    try { $ErrorActionPreference = 'Continue'; & taskkill.exe /PID $env:RCMCP_TRACK_PID /T /F *> $null }
    finally { $ErrorActionPreference = $savedErrorAction }
  }
  $terminated = [RcmcpJobObject]::TerminateJobObject($job, 1)
  if ($target -ne [IntPtr]::Zero) { [RcmcpJobObject]::CloseHandle($target) | Out-Null; $target = [IntPtr]::Zero }
  if (-not $terminated) {
    [Console]::Out.WriteLine('FAILED:TerminateJobObject failed: ' + [RcmcpJobObject]::GetLastError())
    [Console]::Out.Flush()
  } else {
    $deadline = [DateTime]::UtcNow.AddMilliseconds(1800)
    $active = [RcmcpJobObject]::ActiveMembers($job)
    while ($active -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 10
      $active = [RcmcpJobObject]::ActiveMembers($job)
    }
    if ($active -eq 0) {
      [Console]::Out.WriteLine('TERMINATED:0')
    } elseif ($active -lt 0) {
      [Console]::Out.WriteLine('FAILED:QueryInformationJobObject failed: ' + [RcmcpJobObject]::GetLastError())
    } else {
      [Console]::Out.WriteLine('FAILED:Job still has active members: ' + $active)
    }
    [Console]::Out.Flush()
  }
} elseif ($command -eq 'close') {
  [Console]::Out.WriteLine('CLOSED')
  [Console]::Out.Flush()
}
if ($target -ne [IntPtr]::Zero) { [RcmcpJobObject]::CloseHandle($target) | Out-Null }
[RcmcpJobObject]::CloseHandle($job) | Out-Null
`;

export type WindowsJobTermination = {
  terminated: boolean;
  activeMembers: number | null;
  reason?: string;
};

export type WindowsProcessTracker = {
  expectedIdentity: string;
  terminate(): Promise<WindowsJobTermination>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
};

type TrackerEntry = { expectedIdentity: string; pending: Promise<WindowsProcessTracker | null> };
type TrackerRegistry = Map<number, TrackerEntry>;
const trackerRegistryKey = Symbol.for("rcmcp.windows-process-trackers");
const globalState = globalThis as typeof globalThis & { [trackerRegistryKey]?: TrackerRegistry };
const tracked: TrackerRegistry = globalState[trackerRegistryKey] ?? (globalState[trackerRegistryKey] = new Map());

function encodedScript(): string {
  return Buffer.from(trackerScript, "utf16le").toString("base64");
}

function disposeHelper(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    timer = setTimeout(finish, 250);
    timer.unref();
    child.once("close", finish);
    child.once("error", finish);
    try { if (!child.killed) child.kill(); } catch { finish(); }
  });
}

function waitForReady(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
      resolve(value);
    };
    const onData = (chunk: string) => {
      output += chunk;
      if (output.split(/\r?\n/).includes("READY")) finish(true);
    };
    const onClose = () => finish(false);
    child.on("error", () => finish(false));
    child.stdout?.on("data", onData);
    child.once("close", onClose);
  });
}

function sendCommand(child: ChildProcess, command: "terminate" | "close"): Promise<string | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => finish(null), TRACKER_TIMEOUT_MS);
    timer.unref();
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
      child.stdin?.off("error", onStdinError);
      resolve(value);
    };
    const onData = (chunk: string) => {
      output += chunk;
      const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("TERMINATED:") || candidate.startsWith("FAILED:") || candidate === "CLOSED");
      if (line) finish(line);
    };
    const onStdinError = () => finish(null);
    const onClose = () => finish(command === "close" ? "CLOSED" : null);
    child.stdout?.on("data", onData);
    child.once("close", onClose);
    child.stdin?.once("error", onStdinError);
    try {
      child.stdin?.write(command + "\n", (error) => { if (error) finish(null); });
    } catch { finish(null); }
  });
}

async function startTracker(pid: number, expectedIdentity: string): Promise<WindowsProcessTracker | null> {
  if (process.platform !== "win32") return null;
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript()], {
    env: { ...process.env, RCMCP_TRACK_PID: String(pid), RCMCP_TRACK_IDENTITY: expectedIdentity },
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  // Keep late error events harmless even after a timeout or helper exit.
  child.on("error", () => undefined);
  // A write callback can settle before stdin emits EPIPE; keep an error sink
  // for the entire helper lifetime, not only the current command wait.
  child.stdin?.on("error", () => undefined);
  const ready = await waitForReady(child, TRACKER_STARTUP_TIMEOUT_MS);
  if (!ready) {
    await disposeHelper(child);
    return null;
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await disposeHelper(child);
  };
  child.once("close", () => { disposed = true; if (tracked.get(pid)?.expectedIdentity === expectedIdentity) tracked.delete(pid); });
  return {
    expectedIdentity,
    terminate: async () => {
      if (disposed) return { terminated: false, activeMembers: null, reason: "windows_job_helper_closed" };
      const response = await sendCommand(child, "terminate");
      if (!response) { await dispose(); return { terminated: false, activeMembers: null, reason: "windows_job_termination_ack_timeout" }; }
      if (response.startsWith("TERMINATED:")) {
        const activeMembers = Number.parseInt(response.slice("TERMINATED:".length), 10);
        if (activeMembers === 0) return { terminated: true, activeMembers };
      }
      await dispose();
      return { terminated: false, activeMembers: null, reason: response.startsWith("FAILED:") ? "windows_job_termination_unverified: " + response.slice("FAILED:".length) : "windows_job_termination_unverified" };
    },
    close: async () => {
      if (disposed) return;
      const response = await sendCommand(child, "close");
      if (!response) await dispose();
      else disposed = true;
    },
    disconnect: dispose,
  };
}

export function attachWindowsProcessTracker(pid: number, expectedIdentity?: string): Promise<WindowsProcessTracker | null> {
  if (process.platform !== "win32" || !expectedIdentity) return Promise.resolve(null);
  const existing = tracked.get(pid);
  if (existing?.expectedIdentity === expectedIdentity) return existing.pending;
  if (existing) {
    tracked.delete(pid);
    void existing.pending.then((tracker) => tracker?.close().catch(() => undefined));
  }
  const pending = startTracker(pid, expectedIdentity).catch(() => null);
  tracked.set(pid, { expectedIdentity, pending });
  void pending.then((tracker) => {
    const current = tracked.get(pid);
    if (!tracker || current?.pending !== pending) {
      if (tracker) void tracker.close().catch(() => undefined);
      if (current?.pending === pending) tracked.delete(pid);
    }
  });
  return pending;
}

export function trackedWindowsProcess(pid: number, expectedIdentity?: string): Promise<WindowsProcessTracker | null> | undefined {
  const entry = tracked.get(pid);
  if (!entry || (expectedIdentity && entry.expectedIdentity !== expectedIdentity)) return undefined;
  return entry.pending;
}

export async function releaseWindowsProcessTracker(pid: number, expectedIdentity?: string): Promise<void> {
  const entry = tracked.get(pid);
  if (!entry || (expectedIdentity && entry.expectedIdentity !== expectedIdentity)) return;
  tracked.delete(pid);
  const tracker = await entry.pending.catch(() => null);
  if (tracker) await tracker.close().catch(() => undefined);
}

/** Test/recovery seam: drop only the helper pipe; never terminate the job. */
export async function disconnectWindowsProcessTracker(pid: number, expectedIdentity?: string): Promise<void> {
  const entry = tracked.get(pid);
  if (!entry || (expectedIdentity && entry.expectedIdentity !== expectedIdentity)) return;
  tracked.delete(pid);
  const tracker = await entry.pending.catch(() => null);
  if (tracker) await tracker.disconnect().catch(() => undefined);
}

export async function terminateTrackedWindowsProcess(pid: number, expectedIdentity?: string): Promise<WindowsJobTermination | null> {
  const entry = tracked.get(pid);
  if (!entry || (expectedIdentity && entry.expectedIdentity !== expectedIdentity)) return null;
  tracked.delete(pid);
  let timeout: NodeJS.Timeout | undefined;
  const tracker = await Promise.race([
    entry.pending.catch(() => null),
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 250); }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!tracker) {
    void entry.pending.then((lateTracker) => lateTracker?.terminate().catch(() => undefined));
    return null;
  }
  return tracker.terminate();
}
