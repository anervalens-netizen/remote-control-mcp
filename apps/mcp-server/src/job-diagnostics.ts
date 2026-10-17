/** Review long-lived jobs without inventing a timeout or terminating work. */
export function withJobDiagnostics<T>(value: T, now = Date.now()): T {
  if (Array.isArray(value)) return value.map(item => withJobDiagnostics(item, now)) as T;
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (row.job && typeof row.job === "object") return { ...row, job: withJobDiagnostics(row.job, now) } as T;
  if (Array.isArray(row.items)) return { ...row, items: withJobDiagnostics(row.items, now) } as T;
  if (Array.isArray(row.jobs)) return { ...row, jobs: withJobDiagnostics(row.jobs, now) } as T;
  if (typeof row.id !== "string" || !["running", "cancelling"].includes(String(row.state))) return value;
  const started = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : NaN;
  const configured = Number(process.env.RCMCP_JOB_REVIEW_AFTER_MS);
  const threshold = Number.isSafeInteger(configured) && configured >= 60_000 && configured <= 7 * 86_400_000 ? configured : 6 * 3_600_000;
  if (!Number.isFinite(started) || now - started < threshold) return value;
  return { ...row, lifecycleDiagnostics: { reviewRecommended: true, reason: "long_running",
    elapsedMs: now - started, reviewAfterMs: threshold, observedAt: new Date(now).toISOString(),
    guidance: "Inspect job output and process activity. Long runtime alone does not prove a hang; do not replay or automatically cancel." } } as T;
}
