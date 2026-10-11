// Worst-case JSON escaping is six bytes per input byte. Account for both
// content and structured copies and envelope space before dispatching effects.
export function assertAggregateBudget(byteBounds: number[], limit = 256 * 1024 * 1024) {
  const estimatedBytes = byteBounds.reduce((sum, bytes) => sum + bytes * 12 + 16384, 0);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limit)
    throw new Error(`aggregate_result_budget_exceeded: estimated ${estimatedBytes} bytes exceeds ${limit}; no dispatch occurred. Reduce page/output sizes or use keyed durable batch with job_output_since.`);
  return estimatedBytes;
}

