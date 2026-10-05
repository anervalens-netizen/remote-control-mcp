import { SharedJobObserver } from "./shared-job-observer.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { JobFollowInput } from "../../../packages/protocol/src/project.ts";
import { jobOutput, jobStatusAsync } from "./jobs.ts";
import { utf8SafeLength, utf8LeadingCodePointLength } from "./state.ts";

async function subscriberSample<T>(sample: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return sample();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Job follower cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([sample(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
function page(id: string, stream: "stdout" | "stderr", offset: number, length: number, encoding: "utf8" | "base64", terminal: boolean) {
  const raw = jobOutput({ id, stream, offset, length: Math.max(4, length), encoding: "base64" });
  const bytes = Buffer.from(raw.data, "base64");
  let count = Math.min(bytes.length, length);
  if (encoding === "utf8") {
    const safe = utf8SafeLength(bytes.subarray(0, count));
    if (safe < count && (count < bytes.length || !raw.eof || !terminal)) count = safe;
    if (count === 0 && bytes.length > 0) {
      const leading = utf8LeadingCodePointLength(bytes);
      count = bytes.length < leading && terminal && raw.eof ? bytes.length : utf8SafeLength(bytes.subarray(0, Math.min(leading, bytes.length)));
    }
  }
  const data = bytes.subarray(0, count);
  return { stream, offset: raw.offset, nextOffset: raw.offset + count, totalBytes: raw.totalBytes,
    eof: raw.offset + count >= raw.totalBytes, data: data.toString(encoding), bytes: count, encoding };
}
export const jobObservers = new SharedJobObserver(jobStatusAsync);
export const JOB_WAIT_DEFAULT_MS = 20_000;
export const JOB_WAIT_MAX_MS = 20_000;
export const JOB_WAIT_RETRY_AFTER_MS = 750;
export function jobWaitPolicy(requested?: number) {
  const requestedWaitMs = requested ?? JOB_WAIT_DEFAULT_MS;
  const effectiveWaitMs = Math.min(requestedWaitMs, JOB_WAIT_MAX_MS);
  return { requestedWaitMs, effectiveWaitMs, waitClamped: effectiveWaitMs !== requestedWaitMs };
}
export async function jobFollow(input: JobFollowInput, signal?: AbortSignal) {
  const start = performance.now(), wait = jobWaitPolicy(input.waitMs), waitMs = wait.effectiveWaitMs;
  const cursor = input.cursor ?? { stdout: 0, stderr: 0 };
  const encoding = input.encoding ?? "utf8", maxBytes = input.maxBytes ?? 64 * 1024;
  signal?.throwIfAborted();
  const observer = jobObservers.acquire(input.id);
  try {
  let status = await subscriberSample(observer.sample, signal), pollMs = 250;
  while (status.state === "running" || status.state === "cancelling") {
    signal?.throwIfAborted();
    if (input.until === "output" && (status.stdoutBytes > cursor.stdout || status.stderrBytes > cursor.stderr)) {
      if (page(input.id, "stdout", cursor.stdout, maxBytes, encoding, false).bytes || page(input.id, "stderr", cursor.stderr, maxBytes, encoding, false).bytes) break;
    }
    const remaining = waitMs - (performance.now() - start);
    if (remaining <= 0) break;
    await delay(Math.min(remaining, pollMs), undefined, { signal });
    status = await subscriberSample(observer.sample, signal);
    pollMs = Math.min(input.until === "output" ? 500 : 1000, Math.ceil(pollMs * 1.5));
  }
  const terminal = status.state !== "running" && status.state !== "cancelling";
  const stdout = page(input.id, "stdout", cursor.stdout, maxBytes, encoding, terminal);
  const stderr = page(input.id, "stderr", cursor.stderr, maxBytes, encoding, terminal);
  return { ...status, terminal, waitExpired: !terminal && performance.now() - start >= waitMs,
    stdout, stderr, cursor: { stdout: stdout.nextOffset, stderr: stderr.nextOffset },
    outputComplete: terminal && stdout.eof && stderr.eof, waitedMs: Math.round(performance.now() - start),
    ...(wait.waitClamped ? wait : {}),
    retryAfterMs: JOB_WAIT_RETRY_AFTER_MS,
    retryGuidance: "On waitExpired, wait at least retryAfterMs, then call job_wait again with the returned cursor; do not alternate rapid job_status polls.",
  };
  } finally { observer.release(); }
}
