import { createDeadline } from "../../../packages/protocol/src/deadline.ts";
import crossSpawn from "cross-spawn";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import process from "node:process";
import type { ExecRequest, ExecResult } from "../../../packages/protocol/src/index.ts";
import { currentProcessIdentityAsync, terminateVerifiedProcessTreeDetailedAsync, trackProcessLineage, type ProcessLineageTracker } from "./process-identity.ts";
import { runtimeEnv } from "./runtime-env.ts";

const EXECUTION_MARKER_KEY = "RCMCP_EXECUTION_ID";
const TERMINATION_TIMEOUT_MS = 500;
const DRAIN_TIMEOUT_MS = 500;

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] };
  }
  return { file: "/bin/bash", args: ["-lc", command] };
}

export async function runProcess(
  file: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number; portable?: boolean; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  options.signal?.throwIfAborted();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const windows = process.platform === "win32";
  const executionId = randomUUID();
  const executionMarker = `${EXECUTION_MARKER_KEY}=${executionId}`;
  const spawnChild = options.portable ? crossSpawn : spawn;
  const child = spawnChild(file, args, {
    cwd: options.cwd,
    env: runtimeEnv({ ...(options.env ?? {}), [EXECUTION_MARKER_KEY]: executionId }),
    windowsHide: true,
    detached: !windows,
    stdio: "pipe",
  });

  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutSaved = 0;
  let stderrSaved = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let cancellationRequested = false;
  let terminationVerified: boolean | undefined;
  let terminationForced = false;
  let terminationError: string | undefined;
  let terminationVerification: "identity_bound_job" | "posix_identity_set" | "partial_windows_job" | "unverified_windows_fallback" | undefined;
  let terminationVerificationScope: "whole_tree" | "root_and_descendants_created_after_attach" | "root_only" | "unverified" | undefined;
  let terminationReason: string | undefined;
  let drainTimedOut = false;
  let processIdentity: string | undefined;
  let lineageTracker: ProcessLineageTracker | undefined;

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    const remaining = maxOutputBytes - stdoutSaved;
    if (remaining > 0) {
      const part = chunk.subarray(0, remaining);
      stdoutChunks.push(part);
      stdoutSaved += part.length;
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    const remaining = maxOutputBytes - stderrSaved;
    if (remaining > 0) {
      const part = chunk.subarray(0, remaining);
      stderrChunks.push(part);
      stderrSaved += part.length;
    }
  });

  const timeoutMs = options.timeoutMs ?? 120_000;
  let timeout: ReturnType<typeof createDeadline> | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let closeSeen = false;
  let terminationHandling = false;
  let identityPromise: Promise<void> = Promise.resolve();
  let lastExit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let abortListener: (() => void) | undefined;

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return;
      settled = true;
      lineageTracker?.stop();
      if (abortListener && timeout?.signal) timeout.signal.removeEventListener("abort", abortListener);
      timeout?.dispose();
      if (drainTimer) clearTimeout(drainTimer);
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      lineageTracker?.stop();
      if (abortListener && timeout?.signal) timeout.signal.removeEventListener("abort", abortListener);
      timeout?.dispose();
      if (drainTimer) clearTimeout(drainTimer);
      reject(error);
    };

    const handleAbort = async () => {
      if (settled) return;
      timedOut = timeout?.timedOut() === true;
      cancellationRequested = !timedOut;
      terminationHandling = true;
      if (child.pid) {
        try {
          await identityPromise;
          const terminated = await terminateVerifiedProcessTreeDetailedAsync(
            child.pid,
            processIdentity,
            startedAt,
            TERMINATION_TIMEOUT_MS,
            "SIGTERM",
            executionMarker,
            lineageTracker?.capture() ?? [],
          );
          terminationVerified = terminated.terminated;
          terminationForced = terminated.forced;
          if (!terminated.terminated && terminated.reason) terminationError = terminated.reason;
          terminationVerification = terminated.verification;
          terminationVerificationScope = terminated.verificationScope;
          terminationReason = terminated.reason;
        } catch (error) {
          terminationVerified = false;
          terminationError = error instanceof Error ? error.message : String(error);
        }
      } else {
        terminationVerified = false;
        terminationError = "process started without a PID";
      }

      if (settled) return;
      if (closeSeen) {
        finish(lastExit);
        return;
      }

      // Node's close event waits for inherited stdout/stderr handles, so it is
      // not itself proof that all execution-owned descendants stopped. Once
      // termination has been attempted, bound the remaining pipe drain.
      drainTimer = setTimeout(() => {
        if (settled) return;
        drainTimedOut = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(lastExit);
      }, DRAIN_TIMEOUT_MS);
    };

    // Retain the listener for the full child lifetime: spawn failures and late
    // pipe/process errors must remain controlled instead of becoming an
    // unhandled EventEmitter error after the request has settled.
    child.on("error", (error) => fail(error));
    child.once("exit", (code, signal) => {
      lastExit = { code, signal };
    });
    child.once("close", (code, signal) => {
      closeSeen = true;
      lastExit = { code, signal };
      if (!terminationHandling) finish(lastExit);
    });
    child.once("spawn", () => {
      // Capture the process identity promise before observing a pending caller
      // abort. On Windows, cancellation authority must be bound to the process
      // creation identity before taskkill can be attempted safely.
      if (child.pid) {
        identityPromise = currentProcessIdentityAsync(child.pid)
          .then((identity) => {
            processIdentity = identity ?? undefined;
            if (!windows && processIdentity && child.pid && !settled) {
              lineageTracker = trackProcessLineage(child.pid, processIdentity);
            }
            // Short exec keeps native taskkill-tree capability with a pinned,
            // identity-checked root handle. Do not compile a per-exec Job Object
            // helper whose startup can outlive the entire command deadline.
            // Durable jobs and PTYs retain post-launch tracking; neither path
            // overclaims complete historical Windows descendant membership.
          })
          .catch(() => { processIdentity = undefined; });
      }
      // Arm caller cancellation and the command deadline after identity capture
      // has been scheduled. handleAbort awaits that promise before termination.
      if (timeoutMs > 0 || options.signal) {
        timeout = createDeadline(timeoutMs, options.signal);
        if (timeout.signal) {
          abortListener = () => { void handleAbort(); };
          if (timeout.signal.aborted) abortListener();
          else timeout.signal.addEventListener("abort", abortListener, { once: true });
        }
      }
    });
  });

  return {
    code: result.code,
    signal: result.signal,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    durationMs: Math.round(performance.now() - started),
    timedOut,
    ...(cancellationRequested ? { cancellationRequested: true } : {}),
    ...(cancellationRequested && terminationVerified === true ? { cancelled: true } : {}),
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutBytes > stdoutSaved,
    stderrTruncated: stderrBytes > stderrSaved,
    ...(timedOut || cancellationRequested ? {
      terminationVerified: terminationVerified === true,
      terminationForced,
      drainTimedOut,
      ...(terminationError ? { terminationError } : {}),
      ...(terminationVerification ? { terminationVerification } : {}),
      ...(terminationVerificationScope ? { terminationVerificationScope } : {}),
      ...(terminationReason ? { terminationReason } : {}),
    } : {}),
  };
}

export async function runCommand(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult> {
  const shell = shellCommand(request.command);
  return runProcess(shell.file, shell.args, {
    cwd: request.cwd,
    env: request.env,
    timeoutMs: request.timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
    signal,
  });
}
