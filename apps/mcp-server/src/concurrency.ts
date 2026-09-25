export const DEFAULT_BATCH_CONCURRENCY = 8;

export function boundedConcurrency(requested: number | undefined, itemCount: number, fallback = DEFAULT_BATCH_CONCURRENCY): number {
  if (itemCount <= 0) return 0;
  const value = requested ?? fallback;
  return Math.max(1, Math.min(Math.floor(value), itemCount));
}

export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number | undefined,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  signal?.throwIfAborted();
  const results = new Array<R>(items.length);
  let cursor = 0;
  let stopped = false;
  let failure: unknown;
  const stopForAbort = () => {
    if (!signal?.aborted) return false;
    if (!stopped) {
      stopped = true;
      failure = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    return true;
  };
  const workers = Array.from({ length: boundedConcurrency(concurrency, items.length) }, async () => {
    while (true) {
      if (stopped) return;
      if (stopForAbort()) return;
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failure = error;
        }
        return;
      }
    }
  });
  // Always drain workers that were already active. Once one fails or caller
  // cancellation is observed, stopped=true prevents additional mutations.
  await Promise.all(workers);
  if (failure === undefined) stopForAbort();
  if (failure !== undefined) throw failure;
  return results;
}

export async function settledLimit<T>(
  items: readonly T[],
  concurrency: number | undefined,
  fn: (item: T, index: number) => Promise<unknown>,
  signal?: AbortSignal,
) {
  return mapLimit(items, concurrency, async (item, index) => {
    try { return { index, ok: true as const, result: await fn(item, index) }; }
    catch (error) { return { index, ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
  }, signal);
}
