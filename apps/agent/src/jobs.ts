import { jobRecoveryPayload, type JobRecoveryDetails } from "../../../packages/protocol/src/job-recovery.ts";
import { jobLineageSchema } from "../../../packages/protocol/src/project.ts";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  matchesStoredProcessIdentity,
  processAlive,
  currentProcessIdentity,
  currentProcessIdentityAsync,
  terminateVerifiedProcessTree,
  terminateVerifiedProcessTreeDetailedAsync,
  verifiedProcessTreeAlive,
  trackProcessLineage,
  type ProcessIdentityTarget,
  type ProcessLineageTracker,
} from "./process-identity.ts";
import { runtimeEnv } from "./runtime-env.ts";
import { runtimeInstanceId } from "./runtime.ts";
import { atomicWriteJson, ensureStateDir } from "./state.ts";
import { attachWindowsProcessTracker, releaseWindowsProcessTracker } from "./windows-process-tracker.ts";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type JobState = "running" | "cancelling" | "completed" | "cancelled" | "lost";
type JobMeta = {
  id: string; command: string; cwd: string | null; pid: number; state: JobState;
  startedAt: string; finishedAt?: string; exitCode?: number | null; signal?: string | null;
  stdoutPath: string; stderrPath: string; exitPath: string;
  processIdentity?: string; ownerInstanceId?: string; recoveryReason?: string;
  processGoneObservedAt?: string;
  executionMarker?: string;
  trackedProcesses?: ProcessIdentityTarget[];
  terminationVerified?: boolean;
  terminationForced?: boolean;
  terminationVerification?: "identity_bound_job" | "posix_identity_set" | "partial_windows_job" | "unverified_windows_fallback";
  terminationVerificationScope?: "whole_tree" | "root_and_descendants_created_after_attach" | "root_only" | "unverified";
  terminationReason?: string;
  cancellationError?: string;
};

export type { JobRecoveryDetails } from "../../../packages/protocol/src/job-recovery.ts";
export type JobRecoveryStatus = JobRecoveryDetails["processStatus"];

export class JobRecoveryError extends Error {
  readonly code = "job_recovery_required";
  readonly recovery: JobRecoveryDetails;
  readonly jobId: string;
  readonly pid: number;
  readonly processIdentity?: string;
  readonly executionMarker: string;
  readonly marker: string;
  readonly metadataPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly exitPath: string;
  readonly processStatus: JobRecoveryStatus;
  readonly terminationVerified: boolean;
  readonly persistenceError?: string;
  readonly persistenceErrorCode?: string;
  readonly terminationError?: string;
  readonly terminationReason?: string;
  readonly cleanupErrors?: string[];

  constructor(message: string, recovery: JobRecoveryDetails) {
    super(message);
    this.name = "JobRecoveryError";
    // Keep the in-memory receipt bounded too, preserving truncation through HTTP/MCP.
    const { error: _error, name: _name, message: _message, ...boundedRecovery } = jobRecoveryPayload({ error: this.code, message, ...recovery })!;
    recovery = boundedRecovery;
    this.recovery = recovery;
    this.jobId = recovery.jobId;
    this.pid = recovery.pid;
    this.processIdentity = recovery.processIdentity;
    this.executionMarker = recovery.executionMarker;
    this.marker = recovery.marker;
    this.metadataPath = recovery.metadataPath;
    this.stdoutPath = recovery.stdoutPath;
    this.stderrPath = recovery.stderrPath;
    this.exitPath = recovery.exitPath;
    this.processStatus = recovery.processStatus;
    this.terminationVerified = recovery.terminationVerified;
    this.persistenceError = recovery.persistenceError;
    this.persistenceErrorCode = recovery.persistenceErrorCode;
    this.terminationError = recovery.terminationError;
    this.terminationReason = recovery.terminationReason;
    this.cleanupErrors = recovery.cleanupErrors;
  }

  toJSON() {
    return jobRecoveryPayload({ error: this.code, message: this.message, ...this.recovery })!;
  }
}

const jobsRoot = ensureStateDir("jobs");
const live = new Map<string, ChildProcess>();
const windowsLive = new Set<string>();
const cancelInFlight = new Map<string, Promise<ReturnType<typeof summary>>>();
const lineageWatchers = new Map<string, ProcessLineageTracker>();
const EXIT_MARKER_GRACE_MS = 1500;
const exitMarkerHelperContent = `import { closeSync, existsSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const destination = process.argv[2];
const code = Number.parseInt(process.argv[3] ?? "", 10);
const stdoutPath = process.argv[4];
const stderrPath = process.argv[5];
if (!destination || !Number.isFinite(code) || !stdoutPath || !stderrPath) throw new Error("usage: exit-marker <destination> <exit-code> <stdout> <stderr>");

for (const logPath of [stdoutPath, stderrPath]) {
  if (!existsSync(logPath)) continue;
  const log = openSync(logPath, "r+");
  try { fsyncSync(log); } finally { closeSync(log); }
}

const temporary = destination + ".tmp." + process.pid;
writeFileSync(temporary, String(code) + "\\n", { mode: 0o600 });
const file = openSync(temporary, "r+");
try { fsyncSync(file); } finally { closeSync(file); }
renameSync(temporary, destination);
if (process.platform !== "win32") {
  const directory = openSync(path.dirname(destination), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
`;

const linuxRunnerContent = '#!/bin/bash\n/bin/bash -lc "$RCMCP_JOB_COMMAND"\ncode=$?\n"$RCMCP_JOB_NODE" "$RCMCP_JOB_EXIT_HELPER" "$RCMCP_JOB_EXIT_FILE" "$code" "$RCMCP_JOB_STDOUT" "$RCMCP_JOB_STDERR"\nhelper=$?\nif [ "$helper" -ne 0 ]; then exit "$helper"; fi\nexit "$code"\n';
const windowsRunnerContent = `$ErrorActionPreference = "Continue"
$wrapped = '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ' + $env:RCMCP_JOB_COMMAND
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapped))
$argsList = @('-NoLogo','-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',$encoded)
$params = @{
  FilePath = 'powershell.exe'
  ArgumentList = $argsList
  PassThru = $true
  Wait = $true
  WindowStyle = 'Hidden'
  RedirectStandardOutput = $env:RCMCP_JOB_STDOUT
  RedirectStandardError = $env:RCMCP_JOB_STDERR
}
if ($env:RCMCP_JOB_CWD) { $params.WorkingDirectory = $env:RCMCP_JOB_CWD }
try {
  $p = Start-Process @params
  $code = [int]$p.ExitCode
} catch {
  ($_ | Out-String) | Add-Content -LiteralPath $env:RCMCP_JOB_STDERR -Encoding UTF8
  $code = 1
}
$helperOutput = & $env:RCMCP_JOB_NODE $env:RCMCP_JOB_EXIT_HELPER $env:RCMCP_JOB_EXIT_FILE $code $env:RCMCP_JOB_STDOUT $env:RCMCP_JOB_STDERR 2>&1
$helperCode = $LASTEXITCODE
if ($helperCode -ne 0) {
  ($helperOutput | Out-String) | Add-Content -LiteralPath $env:RCMCP_JOB_STDERR -Encoding UTF8
  exit $helperCode
}
exit [int]$code
`;

const immutableWait = new Int32Array(new SharedArrayBuffer(4));

function immutableContentMatches(file: string, content: string): boolean {
  try { return readFileSync(file, "utf8") === content; }
  catch (error) {
    if (["ENOENT", "EACCES", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function waitForImmutableContent(file: string, content: string, timeoutMs = 1000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (immutableContentMatches(file, content)) return true;
    Atomics.wait(immutableWait, 0, 0, 10);
  }
  return immutableContentMatches(file, content);
}

function publishImmutableFile(file: string, content: string, mode: number): boolean {
  try {
    writeFileSync(file, content, { mode, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  const handle = openSync(file, "r+");
  try { fsyncSync(handle); } finally { closeSync(handle); }
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  return true;
}

export function immutableStateFile(prefix: string, extension: string, content: string, mode: number): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  const file = path.join(jobsRoot, prefix + "-" + digest + "." + extension);
  if (publishImmutableFile(file, content, mode) || waitForImmutableContent(file, content)) return file;

  const quarantine = file + ".corrupt-" + process.pid + "-" + randomUUID();
  let quarantined = false;
  try {
    try {
      renameSync(file, quarantine);
      quarantined = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!publishImmutableFile(file, content, mode) && !waitForImmutableContent(file, content)) {
      throw new Error("Immutable state file content mismatch: " + file);
    }
  } finally {
    if (quarantined) rmSync(quarantine, { force: true });
  }
  return file;
}

const exitMarkerHelper = immutableStateFile("_helper-exit-marker", "mjs", exitMarkerHelperContent, 0o600);
const linuxRunner = immutableStateFile("_runner-linux", "sh", linuxRunnerContent, 0o700);
const windowsRunner = immutableStateFile("_runner-windows", "ps1", windowsRunnerContent, 0o600);

function metaPath(id: string) { return path.join(jobsRoot, `${id}.json`); }
function outputPath(id: string, stream: "stdout" | "stderr") { return path.join(jobsRoot, `${id}.${stream}.log`); }
function exitPath(id: string) { return path.join(jobsRoot, `${id}.exit`); }
function readMeta(id: string): JobMeta {
  const file = metaPath(id);
  if (!existsSync(file)) throw new Error(`Unknown job: ${id}`);
  return JSON.parse(readFileSync(file, "utf8")) as JobMeta;
}
function writeMeta(meta: JobMeta) { atomicWriteJson(metaPath(meta.id), meta); }

function cleanupJobArtifacts(meta: JobMeta): string[] {
  const errors: string[] = [];
  for (const file of [metaPath(meta.id), meta.stdoutPath, meta.stderrPath, meta.exitPath, progressPath(meta.id)]) {
    try { rmSync(file, { force: true }); }
    catch (error) { errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return errors;
}

function recoveryDetails(meta: JobMeta, processStatus: JobRecoveryStatus, persistenceCause: unknown, terminationError?: string, terminationReason?: string, cleanupErrors?: string[]): JobRecoveryDetails {
  return {
    jobId: meta.id,
    pid: meta.pid,
    ...(meta.processIdentity ? { processIdentity: meta.processIdentity } : {}),
    executionMarker: meta.executionMarker ?? "",
    marker: meta.executionMarker ?? "",
    metadataPath: metaPath(meta.id),
    stdoutPath: meta.stdoutPath,
    stderrPath: meta.stderrPath,
    exitPath: meta.exitPath,
    processStatus,
    terminationVerified: processStatus === "stopped",
    persistenceError: persistenceCause instanceof Error ? persistenceCause.message : String(persistenceCause),
    ...(persistenceCause && typeof persistenceCause === "object" && "code" in persistenceCause && typeof persistenceCause.code === "string"
      ? { persistenceErrorCode: persistenceCause.code } : {}),
    ...(terminationError ? { terminationError } : {}),
    ...(terminationReason ? { terminationReason } : {}),
    ...(cleanupErrors?.length ? { cleanupErrors } : {}),
  };
}

function stopJobLineage(id: string): void {
  const tracker = lineageWatchers.get(id);
  if (!tracker) return;
  lineageWatchers.delete(id);
  tracker.stop();
}

function ensureJobLineageTracking(meta: JobMeta): void {
  if (process.platform === "win32" || !meta.processIdentity || (meta.state !== "running" && meta.state !== "cancelling")) {
    stopJobLineage(meta.id);
    return;
  }
  if (lineageWatchers.has(meta.id)) return;
  const seed = meta.trackedProcesses?.length
    ? meta.trackedProcesses
    : [{ pid: meta.pid, identity: meta.processIdentity }];
  if (!meta.trackedProcesses?.length) {
    meta.trackedProcesses = seed;
    writeMeta(meta);
  }
  const tracker = trackProcessLineage(meta.pid, meta.processIdentity, seed, (targets) => {
    try {
      if (!existsSync(metaPath(meta.id))) {
        stopJobLineage(meta.id);
        return;
      }
      const current = readMeta(meta.id);
      if (current.state !== "running" && current.state !== "cancelling") {
        stopJobLineage(meta.id);
        return;
      }
      current.trackedProcesses = targets;
      writeMeta(current);
    } catch {
      // Durable state remains authoritative; a later status/cancel call can
      // restart lineage tracking from the last persisted identity set.
    }
  }, 10);
  lineageWatchers.set(meta.id, tracker);
}

function linuxGroupAlive(pid: number): boolean { try { process.kill(-pid, 0); return true; } catch { return false; } }
function treeAlive(pid: number): boolean { return process.platform === "win32" ? processAlive(pid) : linuxGroupAlive(pid); }

function jobTreeAlive(meta: JobMeta): boolean {
  if (process.platform === "win32" && !windowsLive.has(meta.id)) return false;
  if (process.platform === "win32") return processAlive(meta.pid);
  if (!meta.processIdentity && !meta.executionMarker) return treeAlive(meta.pid);
  return verifiedProcessTreeAlive(meta.pid, meta.processIdentity, meta.startedAt, meta.executionMarker, meta.trackedProcesses);
}

function sameProcess(meta: JobMeta): boolean {
  if (live.has(meta.id)) return processAlive(meta.pid);
  if (process.platform === "win32") return windowsLive.has(meta.id) && processAlive(meta.pid);
  return matchesStoredProcessIdentity(meta.pid, meta.processIdentity, meta.startedAt);
}

function runnerCommand() {
  return process.platform === "win32"
    ? { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsRunner] }
    : { file: "/bin/bash", args: [linuxRunner] };
}

function markLost(meta: JobMeta, reason: string): JobMeta {
  meta.state = "lost";
  meta.finishedAt ??= new Date().toISOString();
  meta.recoveryReason = reason;
  writeMeta(meta);
  return meta;
}

function refresh(meta: JobMeta): JobMeta {
  if (process.platform === "win32" && meta.state === "running" && !meta.processIdentity) {
    // Legacy jobs have no authority to signal a PID; only their durable marker
    // can establish completion, even if that numeric PID is still alive.
    if (existsSync(meta.exitPath)) {
      const parsed = Number.parseInt(readFileSync(meta.exitPath, "utf8").trim(), 10);
      meta.state = "completed"; meta.exitCode = Number.isFinite(parsed) ? parsed : null;
      meta.finishedAt = statSync(meta.exitPath).mtime.toISOString();
      delete meta.recoveryReason; writeMeta(meta); return meta;
    }
    if (!processAlive(meta.pid)) return markLost(meta, "legacy_process_gone_without_exit_marker");
    if (!meta.recoveryReason?.startsWith("legacy_identity_unverified")) {
      meta.recoveryReason = "legacy_identity_unverified_waiting_for_exit"; writeMeta(meta);
    }
    return meta;
  }
  if (process.platform === "win32" && !windowsLive.has(meta.id) && (meta.state === "running" || meta.state === "cancelling")) {
    if (!meta.recoveryReason || meta.recoveryReason === "exit_marker_runner_still_active") {
      meta.recoveryReason = "windows_identity_reconciliation_pending";
      writeMeta(meta);
    }
    return meta;
  }
  if ((meta.state === "running" || meta.state === "cancelling") && existsSync(meta.exitPath)) {
    if (meta.state === "running" && sameProcess(meta)) {
      meta.recoveryReason = "exit_marker_runner_still_active";
      writeMeta(meta);
      return meta;
    }
    if (meta.state === "cancelling" && jobTreeAlive(meta)) {
      const markerVerified = process.platform !== "win32" && meta.executionMarker;
      if (meta.ownerInstanceId !== runtimeInstanceId && !sameProcess(meta) && !markerVerified) {
        return markLost(meta, "cancellation_tree_identity_could_not_be_verified_after_restart");
      }
      if (meta.ownerInstanceId !== runtimeInstanceId) { meta.ownerInstanceId = runtimeInstanceId; writeMeta(meta); }
      return meta;
    }
    if (
      meta.state === "cancelling"
      && process.platform === "win32"
      && meta.executionMarker
      && meta.ownerInstanceId !== runtimeInstanceId
      && !sameProcess(meta)
    ) {
      return markLost(meta, "windows_cancellation_descendants_could_not_be_verified_after_restart");
    }
    if (meta.state === "cancelling" && process.platform === "win32") {
      return markLost(meta, "windows_root_stopped_tree_unverified");
    }
    const raw = readFileSync(meta.exitPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    const wasCancelling = meta.state === "cancelling";
    const cancellationVerificationFailed = wasCancelling && meta.terminationVerified === false;
    meta.state = wasCancelling ? "cancelled" : "completed";
    if (wasCancelling && !cancellationVerificationFailed) meta.terminationVerified = true;
    meta.exitCode = Number.isFinite(parsed) ? parsed : null;
    meta.finishedAt = statSync(meta.exitPath).mtime.toISOString();
    meta.ownerInstanceId = runtimeInstanceId;
    if (!cancellationVerificationFailed) delete meta.recoveryReason;
    delete meta.processGoneObservedAt;
    writeMeta(meta);
    if (process.platform === "win32") void releaseWindowsProcessTracker(meta.pid, meta.processIdentity);
  } else if (meta.state === "running") {
    if (process.platform === "win32") {
      // Synchronous status/list paths must not run a PowerShell identity probe.
      // The async status/cancel paths reconcile identity before making a
      // termination or completion claim.
      if (!processAlive(meta.pid) && !existsSync(meta.exitPath)) return markLost(meta, "windows_root_gone_tree_unverified");
      return meta;
    }
    if (!meta.processIdentity) {
      // Legacy pre-E2 jobs cannot be safely matched to a live PID after restart.
      // Preserve completion tracking via the runner exit file, but never claim or
      // signal the PID. If it is already gone without an exit marker, it is lost.
      if (!treeAlive(meta.pid)) return markLost(meta, "legacy_process_gone_without_exit_marker");
      if (!meta.recoveryReason?.startsWith("legacy_identity_unverified")) {
        meta.recoveryReason = "legacy_identity_unverified_waiting_for_exit";
        writeMeta(meta);
      }
      return meta;
    }
    const currentIdentity = currentProcessIdentity(meta.pid);
    if (!matchesStoredProcessIdentity(meta.pid, meta.processIdentity, meta.startedAt, currentIdentity)) {
      if (meta.executionMarker && jobTreeAlive(meta)) {
        delete meta.processGoneObservedAt;
        meta.recoveryReason = "runner_gone_marker_descendant_active";
        if (meta.ownerInstanceId !== runtimeInstanceId) meta.ownerInstanceId = runtimeInstanceId;
        writeMeta(meta);
        return meta;
      }
      // Once the persisted identity no longer matches, the original runner must
      // never be signalled by PID alone. On busy hosts the PID can be reused
      // before the durable exit marker becomes visible, so both a vanished PID
      // and a reused live PID get the same bounded marker grace.
      const now = Date.now();
      if (!meta.processGoneObservedAt) {
        meta.processGoneObservedAt = new Date(now).toISOString();
        meta.recoveryReason = currentIdentity !== null
          ? "process_identity_mismatch_waiting_for_exit_marker"
          : "process_gone_waiting_for_exit_marker";
        writeMeta(meta);
        return meta;
      }
      const observedAt = Date.parse(meta.processGoneObservedAt);
      if (Number.isFinite(observedAt) && now - observedAt < EXIT_MARKER_GRACE_MS) return meta;
      const identityMismatchObserved = meta.recoveryReason === "process_identity_mismatch_waiting_for_exit_marker";
      return markLost(meta, identityMismatchObserved ? "process_identity_no_longer_matches" : "process_gone_without_exit_marker");
    }
    if (
      meta.processGoneObservedAt
      || meta.recoveryReason === "process_gone_waiting_for_exit_marker"
      || meta.recoveryReason === "process_identity_mismatch_waiting_for_exit_marker"
    ) {
      delete meta.processGoneObservedAt;
      delete meta.recoveryReason;
    }
    if (meta.ownerInstanceId !== runtimeInstanceId) { meta.ownerInstanceId = runtimeInstanceId; writeMeta(meta); }
  } else if (meta.state === "cancelling") {
    if (!jobTreeAlive(meta)) {
      if (process.platform === "win32") {
        return markLost(meta, "windows_root_stopped_tree_unverified");
      }
      meta.state = "cancelled";
      if (meta.terminationVerified !== false) {
        meta.terminationVerified = true;
        delete meta.recoveryReason;
      }
      meta.finishedAt ??= new Date().toISOString();
      writeMeta(meta);
    } else if (meta.ownerInstanceId !== runtimeInstanceId) {
      if (!sameProcess(meta)) return markLost(meta, "cancellation_tree_identity_could_not_be_verified_after_restart");
      meta.ownerInstanceId = runtimeInstanceId;
      writeMeta(meta);
    }
  }
  return meta;
}

function progressPath(id: string) { return path.join(jobsRoot, id + ".progress"); }
function readProgress(meta: JobMeta): Record<string, unknown> {
  const file = progressPath(meta.id);
  if (!existsSync(file)) return {};
  try {
    if (statSync(file).size > 64 * 1024) return { progressError: "Progress file exceeds 64 KiB; inspect via fs_read", progressPath: file };
    const progress = JSON.parse(readFileSync(file, "utf8"));
    const terminal = meta.state !== "running" && meta.state !== "cancelling";
    return { progress, ...(terminal && progress?.state === "running" ? { progressInterrupted: true } : {}) };
  } catch (error) { return { progressError: error instanceof Error ? error.message : String(error) }; }
}

function summary(meta: JobMeta) {
  const fresh = refresh(meta);
  if (fresh.state === "running" || fresh.state === "cancelling") ensureJobLineageTracking(fresh);
  else stopJobLineage(fresh.id);
  // The durable ledger remains private; identity, recovery, termination and
  // progress fields keep their existing public meanings on every platform.
  const { trackedProcesses, ...publicMeta } = fresh;
  return {
    ...publicMeta,
    trackedProcessCount: trackedProcesses?.length ?? 0,
    ...readProgress(fresh),
    stdoutBytes: existsSync(fresh.stdoutPath) ? statSync(fresh.stdoutPath).size : 0,
    stderrBytes: existsSync(fresh.stderrPath) ? statSync(fresh.stderrPath).size : 0,
  };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawned = false;
    const onSpawn = () => { spawned = true; child.off("spawn", onSpawn); resolve(); };
    const onError = (error: Error) => { if (!spawned) { child.off("spawn", onSpawn); reject(error); } };
    child.once("spawn", onSpawn);
    child.on("error", onError);
  });
}

async function waitStopped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!treeAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !treeAlive(pid);
}

async function startWindowsDetachedRunner(input: {
  cwd?: string;
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
}): Promise<number> {
  writeFileSync(input.stdoutPath, "", { flag: "a", mode: 0o600 });
  writeFileSync(input.stderrPath, "", { flag: "a", mode: 0o600 });
  const encodedCommand = Buffer.from("& $env:RCMCP_JOB_RUNNER", "utf16le").toString("base64");
  const script = [
    "$argsList=@('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-OutputFormat','Text','-EncodedCommand',$env:RCMCP_JOB_ENCODED_COMMAND)",
    "$params=@{FilePath='powershell.exe';ArgumentList=$argsList;PassThru=$true;WindowStyle='Hidden'}",
    "if($env:RCMCP_JOB_CWD){$params.WorkingDirectory=$env:RCMCP_JOB_CWD}",
    "$p=Start-Process @params",
    "[pscustomobject]@{pid=[int]$p.Id}|ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: runtimeEnv({
      ...input.env,
      RCMCP_JOB_COMMAND: input.env?.RCMCP_JOB_COMMAND ?? "",
      RCMCP_JOB_EXIT_FILE: input.exitPath,
      RCMCP_JOB_EXIT_HELPER: exitMarkerHelper,
      RCMCP_JOB_NODE: process.execPath,
      RCMCP_JOB_RUNNER: windowsRunner,
      RCMCP_JOB_ENCODED_COMMAND: encodedCommand,
      RCMCP_JOB_STDOUT: input.stdoutPath,
      RCMCP_JOB_STDERR: input.stderrPath,
      RCMCP_JOB_CWD: input.cwd ?? "",
    }),
  });
  const raw = stdout.trim();
  const parsed = JSON.parse(raw) as { pid?: number };
  if (!parsed.pid || parsed.pid <= 0) throw new Error("Windows durable job runner started without a PID");
  return parsed.pid;
}

export async function jobStart(input: { command: string; cwd?: string; env?: Record<string, string> }) {
  const id = randomUUID();
  const executionMarker = "RCMCP_JOB_ID=" + id;
  const stdoutPath = outputPath(id, "stdout"); const stderrPath = outputPath(id, "stderr"); const donePath = exitPath(id);
  let child: ChildProcess | undefined;
  let pid: number;
  try {
    if (process.platform === "win32") {
      pid = await startWindowsDetachedRunner({
        cwd: input.cwd,
        env: {
          ...input.env,
          RCMCP_JOB_ID: id,
          RCMCP_JOB_COMMAND: input.command,
          RCMCP_JOB_PROGRESS_FILE: progressPath(id),
        },
        stdoutPath,
        stderrPath,
        exitPath: donePath,
      });
    } else {
      const outFd = openSync(stdoutPath, "a", 0o600); const errFd = openSync(stderrPath, "a", 0o600);
      const runner = runnerCommand();
      try {
        child = spawn(runner.file, runner.args, {
          cwd: input.cwd, env: runtimeEnv({
            ...input.env,
            RCMCP_JOB_ID: id,
            RCMCP_JOB_COMMAND: input.command,
            RCMCP_JOB_PROGRESS_FILE: progressPath(id),
            RCMCP_JOB_EXIT_FILE: donePath,
            RCMCP_JOB_EXIT_HELPER: exitMarkerHelper,
            RCMCP_JOB_NODE: process.execPath,
            RCMCP_JOB_STDOUT: stdoutPath,
            RCMCP_JOB_STDERR: stderrPath,
          }), detached: true,
          stdio: ["ignore", outFd, errFd], windowsHide: true,
        });
        await waitForSpawn(child);
      } finally {
        closeSync(outFd); closeSync(errFd);
      }
      if (!child.pid) throw new Error("Job process started without a PID");
      pid = child.pid;
    }
  } catch (error) {
    rmSync(stdoutPath, { force: true }); rmSync(stderrPath, { force: true }); rmSync(donePath, { force: true }); rmSync(progressPath(id), { force: true });
    throw error;
  }

  const processIdentity = await currentProcessIdentityAsync(pid) ?? undefined;
  if (process.platform === "win32" && processIdentity) void attachWindowsProcessTracker(pid, processIdentity);
  const meta: JobMeta = {
    id, command: input.command, cwd: input.cwd ?? null, pid, state: "running",
    startedAt: new Date().toISOString(), stdoutPath, stderrPath, exitPath: donePath,
    processIdentity,
    ownerInstanceId: runtimeInstanceId,
    executionMarker,
    trackedProcesses: process.platform !== "win32" && processIdentity ? [{ pid, identity: processIdentity }] : undefined,
  };
  try {
    writeMeta(meta);
  } catch (error) {
    let termination: Awaited<ReturnType<typeof terminateVerifiedProcessTreeDetailedAsync>> | undefined;
    let terminationError: string | undefined;
    try {
      termination = await terminateVerifiedProcessTreeDetailedAsync(pid, meta.processIdentity, meta.startedAt, 1000, "SIGTERM", executionMarker, meta.trackedProcesses);
    } catch (cause) {
      terminationError = cause instanceof Error ? cause.message : String(cause);
    }
    const stopped = termination?.terminated === true;
    if (stopped) {
      const cleanupErrors = cleanupJobArtifacts(meta);
      if (cleanupErrors.length > 0) {
        throw new JobRecoveryError("Job metadata persistence failed after verified process termination; cleanup is incomplete", recoveryDetails(meta, "stopped", error, terminationError, termination?.reason, cleanupErrors));
      }
      throw error;
    }

    // A failed metadata write is not permission to discard the only recovery
    // evidence. Best-effort publication of a cancelling marker is useful when
    // storage recovered, but the in-memory error remains authoritative when it
    // did not; never claim that the process stopped without proof.
    try {
      const recoveryMeta: JobMeta = {
        ...meta,
        state: "cancelling",
        terminationVerified: false,
        ...(termination?.forced === undefined ? {} : { terminationForced: termination.forced }),
        ...(termination?.reason ? { terminationReason: termination.reason } : {}),
        ...(terminationError ? { cancellationError: terminationError } : {}),
        recoveryReason: "job_start_metadata_persistence_failed_process_uncertain",
      };
      writeMeta(recoveryMeta);
    } catch {
      // The failed storage path may not be able to accept a recovery journal.
    }
    throw new JobRecoveryError("Job metadata persistence failed and process termination is unverified; manual recovery is required", recoveryDetails(
      meta,
      "uncertain",
      error,
      terminationError,
      termination?.reason ?? "termination_not_verified",
    ));
  }

  if (child) {
    live.set(id, child);
    child.once("close", (code, signal) => {
      live.delete(id);
      stopJobLineage(id);
      if (!existsSync(metaPath(id))) return;
      const current = readMeta(id);
      if (current.state === "running") {
        if (existsSync(current.exitPath)) {
          refresh(current);
          return;
        }
        current.state = "lost";
        current.exitCode = code;
        current.finishedAt = new Date().toISOString();
        current.recoveryReason = "runner_exited_without_durable_marker";
      } else if (current.state === "cancelling" && !jobTreeAlive(current)) {
        if (process.platform === "win32") {
          current.state = "lost";
          current.terminationVerified = false;
          current.recoveryReason = "windows_root_stopped_tree_unverified";
        } else {
          current.state = "cancelled";
          if (current.terminationVerified !== false) {
            current.terminationVerified = true;
            delete current.recoveryReason;
          }
        }
        current.finishedAt = new Date().toISOString();
      }
      current.signal = signal;
      writeMeta(current);
    });
    child.on("error", (error) => {
      try { writeFileSync(stderrPath, `${error.stack ?? error.message}\n`, { flag: "a" }); } catch { /* output may already be removed */ }
    });
    child.unref();
  }
  if (process.platform === "win32") windowsLive.add(id);
  return summary(meta);
}

export function jobLineage(input: { id: string; offset?: number; limit?: number }) {
  const { id, offset = 0, limit = 100 } = jobLineageSchema.parse(input);
  const targets = readMeta(id).trackedProcesses ?? [];
  const start = Math.min(offset, targets.length);
  const items = targets.slice(start, start + limit);
  return { id, offset: start, nextOffset: start + items.length, total: targets.length, hasMore: start + items.length < targets.length, items };
}

export function jobStatus(id: string) { return summary(readMeta(id)); }

export function jobOutput(input: { id: string; stream?: "stdout" | "stderr"; offset?: number; length?: number; encoding?: "utf8" | "base64" }) {
  const stream = input.stream ?? "stdout"; const file = outputPath(input.id, stream);
  readMeta(input.id);
  const totalBytes = existsSync(file) ? statSync(file).size : 0;
  const requested = input.offset ?? 0; const offset = requested < 0 ? Math.max(totalBytes + requested, 0) : Math.min(requested, totalBytes);
  const length = Math.min(input.length ?? 64 * 1024, 1024 * 1024, totalBytes - offset);
  const buffer = Buffer.alloc(Math.max(length, 0)); let bytesRead = 0;
  if (length > 0) { const fd = openSync(file, "r"); try { bytesRead = readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); } }
  const data = buffer.subarray(0, bytesRead);
  return { id: input.id, stream, offset, nextOffset: offset + bytesRead, totalBytes, eof: offset + bytesRead >= totalBytes, data: (input.encoding ?? "utf8") === "base64" ? data.toString("base64") : data.toString("utf8") };
}

async function reconcileWindowsJob(meta: JobMeta): Promise<JobMeta> {
  if (process.platform !== "win32" || (meta.state !== "running" && meta.state !== "cancelling")) return meta;
  if (!meta.processIdentity && meta.state === "running") return refresh(meta);
  const currentIdentity = await currentProcessIdentityAsync(meta.pid);
  if (matchesStoredProcessIdentity(meta.pid, meta.processIdentity, meta.startedAt, currentIdentity)) {
    windowsLive.add(meta.id);
    delete meta.processGoneObservedAt;
    if (meta.recoveryReason === "windows_identity_reconciliation_pending" || meta.recoveryReason?.endsWith("waiting_for_exit_marker")) delete meta.recoveryReason;
    writeMeta(meta);
    return refresh(meta);
  }
  windowsLive.delete(meta.id);
  if (meta.state === "cancelling") return markLost(meta, "windows_cancellation_descendants_could_not_be_verified_after_restart");
  if (existsSync(meta.exitPath)) {
    const raw = readFileSync(meta.exitPath, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    meta.state = "completed";
    meta.exitCode = Number.isFinite(parsed) ? parsed : null;
    meta.finishedAt = statSync(meta.exitPath).mtime.toISOString();
    delete meta.recoveryReason;
    delete meta.processGoneObservedAt;
    writeMeta(meta);
    void releaseWindowsProcessTracker(meta.pid, meta.processIdentity);
    return meta;
  }
  const now = Date.now();
  if (!meta.processGoneObservedAt) {
    meta.processGoneObservedAt = new Date(now).toISOString();
    meta.recoveryReason = currentIdentity !== null ? "process_identity_mismatch_waiting_for_exit_marker" : "process_gone_waiting_for_exit_marker";
    writeMeta(meta);
    return meta;
  }
  const observed = Date.parse(meta.processGoneObservedAt);
  if (Number.isFinite(observed) && now - observed < EXIT_MARKER_GRACE_MS) return meta;
  return markLost(meta, meta.recoveryReason === "process_identity_mismatch_waiting_for_exit_marker" ? "process_identity_no_longer_matches" : "process_gone_without_exit_marker");
}

export async function jobStatusAsync(id: string) {
  const meta = readMeta(id);
  if (process.platform === "win32" && (meta.state === "running" || meta.state === "cancelling")) {
    await reconcileWindowsJob(meta);
  }
  return summary(readMeta(id));
}

async function performJobCancel(id: string) {
  const meta = refresh(readMeta(id));
  const reconciled = await reconcileWindowsJob(meta);
  if (reconciled.state !== "running" && reconciled.state !== "cancelling") return summary(reconciled);
  const windowsIdentityVerified = process.platform === "win32" && !windowsLive.has(id)
    ? matchesStoredProcessIdentity(meta.pid, meta.processIdentity, meta.startedAt, await currentProcessIdentityAsync(meta.pid))
    : false;
  if (meta.state !== "running" && meta.state !== "cancelling") return summary(meta);
  if (meta.state === "running" && meta.processGoneObservedAt) {
    // The process is already gone; never signal a possibly reused PID while the
    // durable exit marker is still inside its bounded reconciliation window.
    return summary(meta);
  }
  if (meta.state === "running" && !sameProcess(meta) && !windowsIdentityVerified) {
    if (meta.executionMarker && jobTreeAlive(meta)) {
      // The runner exited but a marker-owned descendant remains. The marker is
      // the authority for this cancellation; never signal a reused root PID.
    } else if (!meta.processIdentity) {
      meta.recoveryReason = "legacy_identity_unverified_cannot_cancel_waiting_for_exit";
      writeMeta(meta);
      return summary(meta);
    } else {
      return summary(markLost(meta, "refused_to_signal_unverified_process_identity"));
    }
  }
  if (
    meta.state === "cancelling"
    && meta.ownerInstanceId !== runtimeInstanceId
    && !sameProcess(meta)
    && !windowsIdentityVerified
    && !(process.platform !== "win32" && meta.executionMarker && jobTreeAlive(meta))
  ) {
    return summary(markLost(meta, "refused_to_signal_unverified_cancellation_tree"));
  }
  meta.state = "cancelling";
  meta.ownerInstanceId = runtimeInstanceId;
  writeMeta(meta);

  let termination;
  try {
    termination = await terminateVerifiedProcessTreeDetailedAsync(
      meta.pid,
      meta.processIdentity,
      meta.startedAt,
      500,
      "SIGTERM",
      meta.executionMarker,
      meta.trackedProcesses,
    );
  } catch (error) {
    const current = readMeta(id);
    current.state = "cancelling";
    current.terminationVerified = false;
    current.cancellationError = error instanceof Error ? error.message : String(error);
    current.recoveryReason = "cancellation_termination_error";
    writeMeta(current);
    return summary(current);
  }

  const current = readMeta(id);
  current.terminationVerified = termination.terminated;
  current.terminationForced = termination.forced;
  if (termination.reason) current.terminationReason = termination.reason;
  else delete current.terminationReason;
  if (termination.verification) current.terminationVerification = termination.verification;
  else delete current.terminationVerification;
  if (termination.verificationScope) current.terminationVerificationScope = termination.verificationScope;
  else delete current.terminationVerificationScope;
  delete current.cancellationError;
  if (!termination.terminated) {
    if (process.platform === "win32" && termination.rootStopped) {
      current.state = "lost";
      current.recoveryReason = "windows_root_stopped_tree_unverified";
    } else {
      current.state = "cancelling";
      current.recoveryReason = "cancellation_incomplete_processes_still_active";
    }
    writeMeta(current);
    return summary(current);
  }

  current.state = "cancelled";
  current.finishedAt ??= new Date().toISOString();
  delete current.recoveryReason;
  writeMeta(current);
  return summary(current);
}

export function jobCancel(id: string) {
  const existing = cancelInFlight.get(id);
  if (existing) return existing;
  const pending = performJobCancel(id);
  cancelInFlight.set(id, pending);
  void pending.then(() => cancelInFlight.delete(id), () => cancelInFlight.delete(id));
  return pending;
}

export function jobList(limit = 100) {
  return readdirSync(jobsRoot).filter((name) => name.endsWith(".json"))
    .map((name) => { try { return summary(readMeta(name.slice(0, -5))); } catch { return null; } })
    .filter((item): item is ReturnType<typeof summary> => item !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, Math.max(1, Math.min(limit, 1000)));
}

export async function jobListAsync(limit = 100) {
  const items = jobList(limit);
  if (process.platform !== "win32") return items;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index]!;
      if (item.state !== "running" && item.state !== "cancelling") continue;
      try { items[index] = await jobStatusAsync(item.id); }
      catch (error) { if (existsSync(metaPath(item.id))) throw error; }
    }
  }));
  return items;
}

export async function jobRemove(id: string, force = false) {
  await jobStatusAsync(id);
  let meta = refresh(readMeta(id));
  if (meta.state === "running" || meta.state === "cancelling") {
    if (!force) throw new Error("Job is still running; cancel it or use force=true");
    await jobCancel(id);
    meta = refresh(readMeta(id));
    if (meta.state === "running" || meta.state === "cancelling") throw new Error(`Job ${id} is still active and was not removed`);
  }
  stopJobLineage(id);
  live.delete(id);
  windowsLive.delete(id);
  void releaseWindowsProcessTracker(meta.pid, meta.processIdentity);
  // Preserve metadata until data handles are released, so a failed removal is retryable.
  for (const file of [outputPath(id, "stdout"), outputPath(id, "stderr"), exitPath(id), progressPath(id), metaPath(id)]) {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(file, { force: true }); break; }
      catch (error) {
        if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  if (meta.state === "lost" && meta.recoveryReason?.startsWith("windows_")) {
    return { id, removed: true, processCleanupVerified: false, orphanPossible: true, recoveryReason: meta.recoveryReason };
  }
  return { id, removed: true };
}
