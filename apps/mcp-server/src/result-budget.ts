// Worst-case escaping takes six bytes in structured content and seven in the
// already-stringified text copy. Round up and reserve envelope space.
export function assertAggregateBudget(byteBounds: number[], limit = 256 * 1024 * 1024) {
  const estimatedBytes = byteBounds.reduce((sum, bytes) => sum + bytes * 14 + 16384, 0);
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > limit)
    throw new Error(`aggregate_result_budget_exceeded: estimated ${estimatedBytes} bytes exceeds ${limit}; no dispatch occurred. Reduce page/output sizes or use keyed durable batch with job_output_since.`);
  return estimatedBytes;
}

