import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import process from "node:process";
import { promisify } from "node:util";
import { terminateTrackedWindowsProcess, trackedWindowsProcess } from "./windows-process-tracker.ts";

const execFileAsync = promisify(execFile);
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

let cachedLinuxBootId: string | undefined;
let cachedLinuxBootTimeMs: number | null | undefined;

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform !== "win32") {
    try {
      const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
      const close = raw.lastIndexOf(")");
      if (close >= 0) {
        const state = raw.slice(close + 1).trim().split(/\s+/)[0];
        if (state === "Z" || state === "X") return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function linuxBootId(): string | null {
  if (process.platform === "win32") return null;
  if (cachedLinuxBootId !== undefined) return cachedLinuxBootId || null;
  try { cachedLinuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { cachedLinuxBootId = ""; }
  return cachedLinuxBootId || null;
}

function linuxBootTimeMs(): number | null {
  if (process.platform === "win32") return null;
  if (cachedLinuxBootTimeMs !== undefined) return cachedLinuxBootTimeMs;
  try {
    const raw = readFileSync("/proc/stat", "utf8");
    const match = /^btime\s+(\d+)$/m.exec(raw);
    cachedLinuxBootTimeMs = match ? Number.parseInt(match[1]!, 10) * 1000 : null;
  } catch {
    cachedLinuxBootTimeMs = null;
  }
  return cachedLinuxBootTimeMs;
}

function linuxStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

export function currentProcessIdentity(pid: number): string | null {
  if (!processAlive(pid)) return null;
  if (process.platform === "win32") {
    try {
      const script = "try {$p=[Diagnostics.Process]::GetProcessById(" + pid + "); try {$p.StartTime.ToUniversalTime().Ticks} finally {$p.Dispose()}} catch {exit 0}";
      const value = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 3000, windowsHide: true,
      }).trim();
      return value ? "win:" + value : null;
    } catch {
      return null;
    }
  }

  const bootId = linuxBootId();
  const startTicks = linuxStartTicks(pid);
  return bootId && startTicks ? "linux:" + bootId + ":" + startTicks : null;
}

export async function currentProcessIdentityAsync(pid: number): Promise<string | null> {
  if (!processAlive(pid)) return null;
  if (process.platform !== "win32") return currentProcessIdentity(pid);
  try {
    const script = "try {$p=[Diagnostics.Process]::GetProcessById(" + pid + "); try {$p.StartTime.ToUniversalTime().Ticks} finally {$p.Dispose()}} catch {exit 0}";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 3000, windowsHide: true,
    });
    const value = stdout.trim();
    return value ? "win:" + value : null;
  } catch {
    return null;
  }
}

export function matchesStoredProcessIdentity(pid: number, storedIdentity: string | undefined, startedAt?: string, observedIdentity?: string | null): boolean {
  if (!storedIdentity) return false;
  const current = observedIdentity === undefined ? currentProcessIdentity(pid) : observedIdentity;
  if (!current) return false;
  if (current === storedIdentity) return true;

  // Backward compatibility for pre-boot-ID Linux identities. These are safe to
  // accept only when the persisted operation was created during the current boot.
  const legacy = /^linux:(\d+)$/.exec(storedIdentity);
  const modern = /^linux:([^:]+):(\d+)$/.exec(current);
  if (!legacy || !modern || legacy[1] !== modern[2]) return false;
  const bootTime = linuxBootTimeMs();
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return bootTime !== null && Number.isFinite(started) && started >= bootTime - 5000;
}

export async function matchesStoredProcessIdentityAsync(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  observedIdentity?: string | null,
): Promise<boolean> {
  if (!storedIdentity) return false;
  const current = observedIdentity === undefined ? await currentProcessIdentityAsync(pid) : observedIdentity;
  return matchesStoredProcessIdentity(pid, storedIdentity, startedAt, current);
}

function sleepSync(milliseconds: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, milliseconds);
}


type LinuxProcessRecord = { pid: number; ppid: number; group: number; session: number; state: string; identity: string | null };

function linuxProcessRecord(pid: number, onAbsent?: () => void): LinuxProcessRecord | null {
  if (process.platform === "win32") return null;
  try {
    const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const startTicks = fields[19] ?? null;
    const bootId = linuxBootId();
    return {
      pid,
      state: fields[0] ?? "?",
      ppid: Number.parseInt(fields[1] ?? "", 10),
      group: Number.parseInt(fields[2] ?? "", 10),
      session: Number.parseInt(fields[3] ?? "", 10),
      identity: bootId && startTicks ? `linux:${bootId}:${startTicks}` : null,
    };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) onAbsent?.();
    return null;
  }
}

function linuxDirectChildPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (!raw) return [];
    return raw.split(/\s+/)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function linuxProcessRecords(): LinuxProcessRecord[] {
  if (process.platform === "win32") return [];
  const records: LinuxProcessRecord[] = [];
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const record = linuxProcessRecord(Number.parseInt(entry, 10));
      if (record) records.push(record);
    }
  } catch { /* /proc may be unavailable */ }
  return records;
}

function linuxRecordAlive(record: LinuxProcessRecord): boolean {
  return record.state !== "Z" && record.state !== "X";
}

function linuxDescendantPids(rootPid: number, records: LinuxProcessRecord[]): number[] {
  const children = new Map<number, number[]>();
  for (const record of records) {
    const list = children.get(record.ppid) ?? [];
    list.push(record.pid);
    children.set(record.ppid, list);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const childPid = pending.pop()!;
    if (seen.has(childPid)) continue;
    seen.add(childPid);
    descendants.push(childPid);
    pending.push(...(children.get(childPid) ?? []));
  }
  return descendants;
}

function linuxProcessHasEnvironmentMarker(pid: number, environmentMarker: string): boolean {
  try {
    return readFileSync("/proc/" + pid + "/environ").toString("utf8").split("\0").includes(environmentMarker);
  } catch {
    return false;
  }
}

export type ProcessIdentityTarget = { pid: number; identity: string };
type VerifiedTarget = ProcessIdentityTarget;

function verifiedTargetKey(target: VerifiedTarget): string {
  return target.pid + ":" + target.identity;
}

function verifiedTargetAlive(target: VerifiedTarget, records?: LinuxProcessRecord[]): boolean {
  if (process.platform !== "win32" && records) {
    const record = records.find((candidate) => candidate.pid === target.pid);
    return Boolean(record && linuxRecordAlive(record) && record.identity === target.identity);
  }
  return currentProcessIdentity(target.pid) === target.identity && processAlive(target.pid);
}

export type ProcessLineageTracker = {
  snapshot(): ProcessIdentityTarget[];
  capture(): ProcessIdentityTarget[];
  stop(): void;
};

export function trackProcessLineage(
  rootPid: number,
  rootIdentity: string | undefined,
  seed: ProcessIdentityTarget[] = [],
  onUpdate?: (targets: ProcessIdentityTarget[]) => void,
  intervalMs = 20,
): ProcessLineageTracker {
  const known = new Map<string, ProcessIdentityTarget>();
  for (const target of seed) known.set(verifiedTargetKey(target), target);
  if (rootIdentity) known.set(verifiedTargetKey({ pid: rootPid, identity: rootIdentity }), { pid: rootPid, identity: rootIdentity });

  const active = new Map(known);
  const snapshot = () => [...known.values()];
  if (process.platform === "win32" || !rootIdentity) {
    return { snapshot, capture: snapshot, stop: () => undefined };
  }

  let stopped = false;
  const scan = () => {
    if (stopped) return;

    // The tracker is a hot path (10-20 ms ticks). Walking all of /proc here
    // blocks the event loop on slower hosts. Traverse only the currently known
    // verified lineage through Linux's direct-children files. Once observed,
    // a child stays in the identity-bound ledger even if it later calls setsid,
    // scrubs its environment, or is reparented after its parent exits.
    const pending: number[] = [];
    const visited = new Set<number>();
    for (const [key, target] of active) {
      const record = linuxProcessRecord(target.pid, () => active.delete(key));
      if (!record) continue; // Permission/transient failure is not proof of death.
      if (!linuxRecordAlive(record) || (record.identity && record.identity !== target.identity)) active.delete(key);
      else if (record.identity === target.identity) pending.push(target.pid);
    }

    let changed = false;
    while (pending.length > 0) {
      const parentPid = pending.pop()!;
      if (visited.has(parentPid)) continue;
      visited.add(parentPid);

      for (const childPid of linuxDirectChildPids(parentPid)) {
        const record = linuxProcessRecord(childPid);
        if (!record || !linuxRecordAlive(record) || !record.identity) continue;
        const target = { pid: record.pid, identity: record.identity };
        const key = verifiedTargetKey(target);
        if (!known.has(key)) {
          known.set(key, target);
          active.set(key, target);
          changed = true;
        }
        if (!visited.has(childPid)) pending.push(childPid);
      }
    }

    if (changed) onUpdate?.(snapshot());
  };
  const capture = () => { scan(); return snapshot(); };

  scan();
  const timer = setInterval(scan, Math.max(5, intervalMs));
  timer.unref();
  return {
    snapshot,
    capture,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

export type ProcessTreeTerminationResult = {
  terminated: boolean;
  forced: boolean;
  verification?: "identity_bound_job" | "posix_identity_set" | "partial_windows_job" | "unverified_windows_fallback";
  verificationScope?: "whole_tree" | "root_and_descendants_created_after_attach" | "root_only" | "unverified";
  rootStopped?: boolean;
  activeMembers?: number | null;
  reason?: string;
};

export function verifiedProcessTreeAlive(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  environmentMarker?: string,
  trackedTargets: ProcessIdentityTarget[] = [],
): boolean {
  // There is no safe synchronous Windows identity probe. Callers handling
  // Windows request state use verifiedProcessTreeAliveAsync instead.
  if (process.platform === "win32") return false;
  if (matchesStoredProcessIdentity(pid, storedIdentity, startedAt)) return true;
  const records = linuxProcessRecords();
  const byPid = new Map(records.map((record) => [record.pid, record]));
  if (trackedTargets.some((target) => {
    const record = byPid.get(target.pid);
    return Boolean(record && linuxRecordAlive(record) && record.identity === target.identity);
  })) return true;
  if (!environmentMarker) return false;
  return records.some(
    (record) => linuxRecordAlive(record) && linuxProcessHasEnvironmentMarker(record.pid, environmentMarker),
  );
}

function assertValidPosixSignal(signal: NodeJS.Signals | number): void {
  const signals = osConstants.signals as Record<string, number>;
  const valid = typeof signal === "string"
    ? Object.prototype.hasOwnProperty.call(signals, signal)
    : Number.isInteger(signal) && Object.values(signals).includes(signal);
  if (!valid) {
    const error = new Error("Unknown signal: " + String(signal)) as NodeJS.ErrnoException;
    error.code = "ERR_UNKNOWN_SIGNAL";
    throw error;
  }
}

export function terminateVerifiedProcessTreeDetailed(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  timeoutMs = 1000,
  initialSignal: NodeJS.Signals | number = "SIGTERM",
  environmentMarker?: string,
  trackedTargets: ProcessIdentityTarget[] = [],
): ProcessTreeTerminationResult {
  const rootInitiallyVerified = matchesStoredProcessIdentity(pid, storedIdentity, startedAt);
  if (process.platform === "win32") {
    // The synchronous compatibility entry point cannot safely own a Windows
    // Job Object or perform an external identity probe. Keep it fail-closed;
    // request paths use the async implementation below.
    if (!rootInitiallyVerified) return { terminated: false, forced: false, reason: "windows_identity_mismatch" };
    return { terminated: false, forced: false, reason: "windows_async_termination_required" };
  }
  if (!rootInitiallyVerified && !environmentMarker) return { terminated: false, forced: false };
  assertValidPosixSignal(initialSignal);

  const firstRecords = linuxProcessRecords();
  const rootRecord = rootInitiallyVerified ? firstRecords.find((record) => record.pid === pid) : undefined;
  const initialSessionId = rootRecord?.session ?? null;
  let verificationAuthorityObserved = rootRecord !== undefined;
  const targets = new Map<string, VerifiedTarget>();
  const firstRecordByPid = new Map(firstRecords.map((record) => [record.pid, record]));
  for (const target of trackedTargets) {
    const record = firstRecordByPid.get(target.pid);
    if (!record || !linuxRecordAlive(record) || record.identity !== target.identity) continue;
    targets.set(verifiedTargetKey(target), target);
    verificationAuthorityObserved = true;
  }
  const signaledInitial = new Set<string>();
  const signaledForced = new Set<string>();

  const rememberPid = (candidatePid: number, record?: LinuxProcessRecord) => {
    const identity = record?.identity ?? currentProcessIdentity(candidatePid);
    if (!identity) return;
    const target = { pid: candidatePid, identity };
    targets.set(verifiedTargetKey(target), target);
  };

  const refreshTargets = (): LinuxProcessRecord[] => {
    const records = linuxProcessRecords();
    const liveRecords = records.filter(linuxRecordAlive);
    const recordByPid = new Map(records.map((record) => [record.pid, record]));

    const rootStillVerified = matchesStoredProcessIdentity(pid, storedIdentity, startedAt, recordByPid.get(pid)?.identity);
    if (rootStillVerified) {
      rememberPid(pid, recordByPid.get(pid));
      for (const descendantPid of linuxDescendantPids(pid, records)) rememberPid(descendantPid, recordByPid.get(descendantPid));
    }

    if (initialSessionId !== null) {
      for (const record of liveRecords) {
        if (record.session === initialSessionId) rememberPid(record.pid, record);
      }
    }

    if (environmentMarker) {
      for (const record of liveRecords) {
        if (!linuxProcessHasEnvironmentMarker(record.pid, environmentMarker)) continue;
        verificationAuthorityObserved = true;
        rememberPid(record.pid, record);
      }
    }

    const knownPids = [...new Set([...targets.values()].map((target) => target.pid))];
    for (const knownPid of knownPids) {
      for (const descendantPid of linuxDescendantPids(knownPid, records)) rememberPid(descendantPid, recordByPid.get(descendantPid));
    }
    return records;
  };

  const liveTargets = (): VerifiedTarget[] => {
    const records = refreshTargets();
    return [...targets.values()].filter((target) => verifiedTargetAlive(target, records));
  };

  const signalNew = (signal: NodeJS.Signals | number, sent: Set<string>) => {
    for (const target of liveTargets()) {
      const key = verifiedTargetKey(target);
      if (sent.has(key)) continue;
      try {
        process.kill(target.pid, signal);
        sent.add(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          sent.add(key);
          continue;
        }
        throw error;
      }
    }
  };

  // If the original PID is already gone and no marker-owned process can be
  // observed, we cannot prove that an escaped process did not scrub its marker.
  // Return an explicit incomplete verification instead of a false success.
  refreshTargets();
  if (!verificationAuthorityObserved) return { terminated: false, forced: false };

  signalNew(initialSignal, signaledInitial);

  const quietWindowMs = 80;
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let emptySince: number | null = null;
  while (Date.now() < deadline) {
    signalNew(initialSignal, signaledInitial);
    if (liveTargets().length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= quietWindowMs) return { terminated: true, forced: false, verification: "posix_identity_set", verificationScope: "whole_tree" };
    } else {
      emptySince = null;
    }
    sleepSync(20);
  }

  let forced = false;
  if (liveTargets().length > 0) {
    forced = true;
    signalNew("SIGKILL", signaledForced);
  }

  const killDeadline = Date.now() + 500;
  emptySince = null;
  while (Date.now() < killDeadline) {
    signalNew("SIGKILL", signaledForced);
    if (liveTargets().length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= quietWindowMs) return { terminated: true, forced, verification: "posix_identity_set", verificationScope: "whole_tree" };
    } else {
      emptySince = null;
    }
    sleepSync(20);
  }
  return {
    terminated: verificationAuthorityObserved && liveTargets().length === 0,
    forced,
    verification: verificationAuthorityObserved && liveTargets().length === 0 ? "posix_identity_set" : undefined,
    verificationScope: verificationAuthorityObserved && liveTargets().length === 0 ? "whole_tree" : undefined,
  };
}

async function terminateWindowsPinnedRoot(pid: number, storedIdentity: string | undefined, timeoutMs: number): Promise<void> {
  if (!storedIdentity) throw new Error("Windows root identity is unavailable");
  const script = "$p=[Diagnostics.Process]::GetProcessById([int]$env:RCMCP_KILL_PID); try {$h=$p.Handle; if(('win:'+$p.StartTime.ToUniversalTime().Ticks) -ne $env:RCMCP_KILL_IDENTITY){throw 'identity mismatch'}; $ErrorActionPreference='Continue'; & taskkill.exe /PID $env:RCMCP_KILL_PID /T /F} finally {$p.Dispose()}";
  await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: Math.max(timeoutMs, 2000),
    env: { ...process.env, RCMCP_KILL_PID: String(pid), RCMCP_KILL_IDENTITY: storedIdentity },
  });
}

export async function terminateVerifiedProcessTreeDetailedAsync(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  timeoutMs = 1000,
  initialSignal: NodeJS.Signals | number = "SIGTERM",
  environmentMarker?: string,
  trackedTargets: ProcessIdentityTarget[] = [],
): Promise<ProcessTreeTerminationResult> {
  // Windows helpers validate creation identity on the retained native handle.
  // A second preliminary PowerShell lookup adds latency but no binding authority.
  const rootInitiallyVerified = process.platform === "win32" && storedIdentity
    ? processAlive(pid)
    : await matchesStoredProcessIdentityAsync(pid, storedIdentity, startedAt);
  if (process.platform === "win32") {
    if (!rootInitiallyVerified) return { terminated: false, forced: false, reason: "windows_identity_mismatch" };
    const tracker = trackedWindowsProcess(pid, storedIdentity);
    if (tracker) {
      const terminated = await terminateTrackedWindowsProcess(pid, storedIdentity);
      const deadline = Date.now() + Math.max(250, Math.min(timeoutMs, 1000));
      while (processAlive(pid) && Date.now() < deadline) await delay(20);
      const rootStopped = !processAlive(pid);
      if (terminated?.terminated === true && rootStopped) {
        await delay(120);
        // The helper was attached after launch. Its active-member query proves
        // only the assigned root and descendants created after assignment; it
        // cannot prove that pre-existing/escaped descendants are absent.
        return {
          terminated: false,
          forced: true,
          verification: "partial_windows_job",
          verificationScope: "root_and_descendants_created_after_attach",
          rootStopped,
          activeMembers: terminated.activeMembers,
          reason: "windows_job_termination_root_stopped_tree_membership_partial_post_launch_attach",
        };
      }
      // An exited root cannot be targeted. A live root is revalidated by the
      // pinned-handle fallback itself, without another PowerShell process.
      if (rootStopped) {
        return {
          terminated: false,
          forced: true,
          verification: "unverified_windows_fallback",
          verificationScope: rootStopped ? "root_only" : "unverified",
          rootStopped,
          activeMembers: terminated?.activeMembers ?? null,
          reason: terminated?.reason ?? "windows_job_termination_root_identity_lost_before_fallback",
        };
      }
      try {
        await terminateWindowsPinnedRoot(pid, storedIdentity, timeoutMs);
      } catch { /* process may already have exited */ }
      return {
        terminated: false,
        forced: true,
        verification: "unverified_windows_fallback",
        verificationScope: "unverified",
        rootStopped: !processAlive(pid),
        activeMembers: terminated?.activeMembers ?? null,
        reason: terminated?.reason ?? "windows_job_termination_unverified",
      };
    }

    // taskkill remains the best available fallback after an agent restart, but
    // numeric-PID tree membership is not proof against an escaped descendant or
    // PID reuse. Preserve the ability to terminate while refusing a false
    // whole-tree/cancelled claim.
    // terminateWindowsPinnedRoot opens and retains the process handle, then
    // compares its creation identity before taskkill. A preliminary lookup
    // adds cold-start latency but no stronger binding or permission check.
    try {
      await terminateWindowsPinnedRoot(pid, storedIdentity, timeoutMs);
    } catch { /* process may already have exited */ }
    const deadline = Date.now() + Math.max(250, Math.min(timeoutMs, 1000));
    while (processAlive(pid) && Date.now() < deadline) await delay(20);
    return {
      terminated: false,
      forced: true,
      verification: "unverified_windows_fallback",
      verificationScope: processAlive(pid) ? "unverified" : "root_only",
      rootStopped: !processAlive(pid),
      reason: processAlive(pid) ? "windows_fallback_process_still_alive" : "windows_tree_membership_unverified",
    };
  }
  if (!rootInitiallyVerified && !environmentMarker) return { terminated: false, forced: false };
  assertValidPosixSignal(initialSignal);

  const firstRecords = linuxProcessRecords();
  const rootRecord = rootInitiallyVerified ? firstRecords.find((record) => record.pid === pid) : undefined;
  const initialSessionId = rootRecord?.session ?? null;
  let verificationAuthorityObserved = rootRecord !== undefined;
  const targets = new Map<string, VerifiedTarget>();
  const firstRecordByPid = new Map(firstRecords.map((record) => [record.pid, record]));
  for (const target of trackedTargets) {
    const record = firstRecordByPid.get(target.pid);
    if (!record || !linuxRecordAlive(record) || record.identity !== target.identity) continue;
    targets.set(verifiedTargetKey(target), target);
    verificationAuthorityObserved = true;
  }
  const signaledInitial = new Set<string>();
  const signaledForced = new Set<string>();

  const rememberPid = (candidatePid: number, record?: LinuxProcessRecord) => {
    const identity = record?.identity ?? currentProcessIdentity(candidatePid);
    if (!identity) return;
    const target = { pid: candidatePid, identity };
    targets.set(verifiedTargetKey(target), target);
  };

  const refreshTargets = (): LinuxProcessRecord[] => {
    const records = linuxProcessRecords();
    const liveRecords = records.filter(linuxRecordAlive);
    const recordByPid = new Map(records.map((record) => [record.pid, record]));
    if (matchesStoredProcessIdentity(pid, storedIdentity, startedAt, recordByPid.get(pid)?.identity)) {
      rememberPid(pid, recordByPid.get(pid));
      for (const descendantPid of linuxDescendantPids(pid, records)) rememberPid(descendantPid, recordByPid.get(descendantPid));
    }
    if (initialSessionId !== null) {
      for (const record of liveRecords) if (record.session === initialSessionId) rememberPid(record.pid, record);
    }
    if (environmentMarker) {
      for (const record of liveRecords) {
        if (!linuxProcessHasEnvironmentMarker(record.pid, environmentMarker)) continue;
        verificationAuthorityObserved = true;
        rememberPid(record.pid, record);
      }
    }
    const knownPids = [...new Set([...targets.values()].map((target) => target.pid))];
    for (const knownPid of knownPids) {
      for (const descendantPid of linuxDescendantPids(knownPid, records)) rememberPid(descendantPid, recordByPid.get(descendantPid));
    }
    return records;
  };

  const liveTargets = (): VerifiedTarget[] => {
    const records = refreshTargets();
    return [...targets.values()].filter((target) => verifiedTargetAlive(target, records));
  };

  const signalNew = (signal: NodeJS.Signals | number, sent: Set<string>) => {
    for (const target of liveTargets()) {
      const key = verifiedTargetKey(target);
      if (sent.has(key)) continue;
      try {
        process.kill(target.pid, signal);
        sent.add(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          sent.add(key);
          continue;
        }
        throw error;
      }
    }
  };

  refreshTargets();
  if (!verificationAuthorityObserved) return { terminated: false, forced: false };
  signalNew(initialSignal, signaledInitial);

  const quietWindowMs = 80;
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let emptySince: number | null = null;
  while (Date.now() < deadline) {
    signalNew(initialSignal, signaledInitial);
    if (liveTargets().length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= quietWindowMs) return { terminated: true, forced: false, verification: "posix_identity_set", verificationScope: "whole_tree" };
    } else {
      emptySince = null;
    }
    await delay(20);
  }

  let forced = false;
  if (liveTargets().length > 0) {
    forced = true;
    signalNew("SIGKILL", signaledForced);
  }
  const killDeadline = Date.now() + 500;
  emptySince = null;
  while (Date.now() < killDeadline) {
    signalNew("SIGKILL", signaledForced);
    if (liveTargets().length === 0) {
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= quietWindowMs) return { terminated: true, forced, verification: "posix_identity_set", verificationScope: "whole_tree" };
    } else {
      emptySince = null;
    }
    await delay(20);
  }
  return {
    terminated: verificationAuthorityObserved && liveTargets().length === 0,
    forced,
    verification: verificationAuthorityObserved && liveTargets().length === 0 ? "posix_identity_set" : undefined,
    verificationScope: verificationAuthorityObserved && liveTargets().length === 0 ? "whole_tree" : undefined,
  };
}

export function terminateVerifiedProcessTree(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  timeoutMs = 1000,
  initialSignal: NodeJS.Signals | number = "SIGTERM",
  environmentMarker?: string,
): boolean {
  return terminateVerifiedProcessTreeDetailed(
    pid, storedIdentity, startedAt, timeoutMs, initialSignal, environmentMarker,
  ).terminated;
}

export function terminateVerifiedProcess(pid: number, storedIdentity: string | undefined, startedAt?: string, timeoutMs = 1000): boolean {
  if (!matchesStoredProcessIdentity(pid, storedIdentity, startedAt)) return false;

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: Math.max(timeoutMs, 1000) });
    } catch { /* process may already have exited */ }
    return !processAlive(pid);
  }

  try { process.kill(pid, "SIGTERM"); } catch { return !processAlive(pid); }
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    if (!matchesStoredProcessIdentity(pid, storedIdentity, startedAt)) return true;
    sleepSync(20);
  }
  if (!matchesStoredProcessIdentity(pid, storedIdentity, startedAt)) return true;
  try { process.kill(pid, "SIGKILL"); } catch { return !processAlive(pid); }
  const killDeadline = Date.now() + 500;
  while (Date.now() < killDeadline) {
    if (!processAlive(pid)) return true;
    if (!matchesStoredProcessIdentity(pid, storedIdentity, startedAt)) return true;
    sleepSync(20);
  }
  return !processAlive(pid);
}

export async function verifiedProcessTreeAliveAsync(
  pid: number,
  storedIdentity: string | undefined,
  startedAt?: string,
  environmentMarker?: string,
): Promise<boolean> {
  if (process.platform === "win32") return await matchesStoredProcessIdentityAsync(pid, storedIdentity, startedAt) && processAlive(pid);
  return verifiedProcessTreeAlive(pid, storedIdentity, startedAt, environmentMarker);
}
