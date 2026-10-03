import { z } from "zod";
export const executionOutcomes = ["exit_zero", "exit_nonzero", "signal", "timeout", "cancelled", "uncertain", "not_started"] as const;
export const executionOutcomeSchema = z.enum(executionOutcomes);
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;
export function executionOutcome(value: Record<string, unknown>): ExecutionOutcome {
  if (value.notStarted === true) return "not_started";
  if (value.timedOut === true) return "timeout";
  if (value.cancelled === true && value.terminationVerified === true) return "cancelled";
  if (value.cancellationRequested === true || value.cancelled === true) return "uncertain";
  if (typeof value.signal === "string") return "signal";
  if (value.code === 0) return "exit_zero";
  if (typeof value.code === "number") return "exit_nonzero";
  return "uncertain";
}
export function executionFacts(value: Record<string, unknown>) {
  return { requestSucceeded: true, executionOutcome: executionOutcome(value), effectVerification: "unverified" as const, clientAcceptance: "unknown" as const };
}
export function summarizeExecution(items: Array<{ ok: boolean; result?: unknown; notStarted?: boolean }>) {
  const counts = Object.fromEntries(executionOutcomes.map(outcome => [outcome, 0])) as Record<ExecutionOutcome, number>;
  let requestErrors = 0;
  for (const item of items) {
    if (!item.ok && !item.notStarted) requestErrors++;
    const outcome = item.notStarted ? "not_started" : item.ok ? executionOutcome(item.result as Record<string, unknown>) : "uncertain";
    counts[outcome]++;
  }
  return { total: items.length, requestSucceeded: items.filter(item => item.ok).length, requestErrors,
    ...counts, effectVerification: "unverified" as const, clientAcceptance: "unknown" as const };
}
export const executionSummarySchema = z.object({
  total: z.number().int().nonnegative(), requestSucceeded: z.number().int().nonnegative(), requestErrors: z.number().int().nonnegative(),
  exit_zero: z.number().int().nonnegative(), exit_nonzero: z.number().int().nonnegative(), signal: z.number().int().nonnegative(),
  timeout: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(), not_started: z.number().int().nonnegative(),
  effectVerification: z.literal("unverified"), clientAcceptance: z.literal("unknown"),
});
