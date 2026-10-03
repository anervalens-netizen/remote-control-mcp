import { boundedConcurrency } from "./concurrency.ts";
import { toolErrorDetails } from "./tool-errors.ts";

/** Cancellation prevents new dispatch, drains active calls, and retains every
 * slot. A rejected active request is uncertain, never relabelled not started. */
export async function settledExecution<T>(items: readonly T[], fn: (item: T, index: number) => Promise<unknown>, concurrency?: number, signal?: AbortSignal) {
  type Entry = { index: number; ok: true; result: unknown } | { index: number; ok: false; error: string; notStarted?: boolean; requestSucceeded: false; executionOutcome: "uncertain" | "not_started"; [key: string]: unknown };
  const results: Entry[] = items.map((_, index) => ({ index, ok: false, error: "Not dispatched: request cancelled", notStarted: true, requestSucceeded: false, executionOutcome: "not_started" }));
  let cursor = 0;
  await Promise.all(Array.from({ length: boundedConcurrency(concurrency, items.length) }, async () => {
    while (!signal?.aborted) {
      const index = cursor++;
      if (index >= items.length) return;
      try { results[index] = { index, ok: true, result: await fn(items[index]!, index) }; }
      catch (error) { results[index] = { ...toolErrorDetails(error), index, ok: false, requestSucceeded: false, executionOutcome: "uncertain" }; }
    }
  }));
  return results;
}
