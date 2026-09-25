import { z } from "zod";

/** Node's native timer delay is a signed 32-bit millisecond value. */
export const NODE_TIMER_MAX_MS = 2_147_483_647;
export const MAX_DEADLINE_MS = Number.MAX_SAFE_INTEGER;
export const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
export const HTTP_GRACE_MS = 5_000;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 30 * 60 * 1000;

/** Shared timeout field for protocol contracts that use the common deadline helper. */
export const timeoutMsField = z.number().int().nonnegative().max(MAX_DEADLINE_MS);

export function withTimeoutGrace(timeoutMs: number, graceMs = HTTP_GRACE_MS): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RangeError("timeoutMs must be a non-negative safe integer");
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new RangeError("graceMs must be a non-negative safe integer");
  return Math.min(MAX_DEADLINE_MS, timeoutMs + graceMs);
}

type TimerHandle = ReturnType<typeof setTimeout>;

function scheduleAbort(controller: AbortController, timeoutMs: number): () => void {
  let handle: TimerHandle | undefined;
  let remaining = timeoutMs;
  let disposed = false;

  const arm = () => {
    if (disposed) return;
    const delay = Math.min(remaining, NODE_TIMER_MAX_MS);
    handle = setTimeout(() => {
      handle = undefined;
      if (disposed) return;
      remaining -= delay;
      if (remaining <= 0) controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      else arm();
    }, delay);
    const maybeUnref = handle as TimerHandle & { unref?: () => void };
    maybeUnref.unref?.();
  };

  arm();
  return () => {
    disposed = true;
    if (handle !== undefined) clearTimeout(handle);
  };
}

export type Deadline = {
  signal?: AbortSignal;
  /** True only when this deadline's own timer fired, not when its caller cancelled. */
  timedOut(): boolean;
  /** Remaining milliseconds, with zero meaning explicitly disabled. */
  remainingMs(): number | undefined;
  /** Cancel the timer and release its resources. */
  dispose(): void;
};

/**
 * Creates one cancellation boundary for a request and its nested operations.
 * A timeout of zero disables the timer; large values are scheduled in safe
 * chunks instead of being passed directly to Node's overflowing setTimeout.
 */
export function createDeadline(timeoutMs: number | undefined, externalSignal?: AbortSignal, defaultTimeoutMs?: number): Deadline {
  const effective = timeoutMs ?? defaultTimeoutMs;
  if (effective !== undefined && (!Number.isSafeInteger(effective) || effective < 0)) {
    throw new RangeError("timeoutMs must be a non-negative safe integer");
  }
  if (effective === undefined || effective === 0) {
    return {
      signal: externalSignal,
      timedOut: () => false,
      remainingMs: () => effective,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const cancelTimer = scheduleAbort(controller, effective);
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  return {
    signal,
    timedOut: () => controller.signal.aborted,
    remainingMs: () => {
      const remaining = Math.max(0, effective - (Date.now() - startedAt));
      if (remaining === 0 && !controller.signal.aborted) controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      return remaining;
    },
    dispose: cancelTimer,
  };
}
