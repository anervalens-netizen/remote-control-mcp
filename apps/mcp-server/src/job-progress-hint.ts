import { JOB_WAIT_RETRY_AFTER_MS } from "../../../packages/protocol/src/project.ts";

/** A small diagnostic hint layered on existing durable job results.
 * Does not derive success, user input or percent from silence/elapsed time.
 */
type JobState = "running" | "cancelling" | "completed" | "cancelled" | "lost";
const states = new Set<JobState>(["running", "cancelling", "completed", "cancelled", "lost"]);
const asBytes = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const asTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export function withActionableJobProgress<T>(value: T, now = Date.now()): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  if (row.state === "resolved" && row.job && typeof row.job === "object") {
    return { ...row, job: withActionableJobProgress(row.job, now) } as T;
  }
  const state = row.state;
  if (typeof row.id !== "string" || !states.has(state as JobState)) return value;
  const current = state as JobState;
  const active = current === "running" || current === "cancelling";
  const waitExpired = row.waitExpired === true;
  const retryAfterMs = Number.isSafeInteger(row.retryAfterMs) && (row.retryAfterMs as number) >= 0
    ? row.retryAfterMs as number : JOB_WAIT_RETRY_AFTER_MS;
  const observedTermination = row.terminationVerified === true ? "verified" :
    row.terminationVerified === false ? "unverified" : "unknown";
  const nextCheck = active
    ? "job_wait"
    : current === "lost" || current === "cancelled" && observedTermination !== "verified"
      ? "job_lineage" : "job_output_since";
  return {
    ...row,
    progressGuidance: {
      state: current,
      terminalRecordObserved: !active,
      waitExpiredWithoutTermination: waitExpired && active,
      cancellationRequested: current === "cancelling" || current === "cancelled",
      terminationEvidence: observedTermination,
      effectVerification: "unknown",
      inputWaitEvidence: "unverified",
      completionPercent: null,
      lastOutputAt: asTime(row.lastOutputAt),
      outputBytes: { stdout: asBytes(row.stdoutBytes), stderr: asBytes(row.stderrBytes) },
      nextCheck,
      ...(active ? { retryAfterMs, useOriginalJobId: true } : {}),
      observedAt: new Date(now).toISOString(),
      basis: "agent_job_metadata_not_client_acceptance",
    },
  } as T;
}
