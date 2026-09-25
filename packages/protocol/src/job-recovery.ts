/** Bounded recovery receipt shared by HTTP and MCP. Unknown body fields never cross this boundary. */
export type JobRecoveryDetails = {
  jobId: string;
  pid: number;
  processIdentity?: string;
  executionMarker: string;
  marker: string;
  metadataPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitPath: string;
  processStatus: "stopped" | "uncertain";
  terminationVerified: boolean;
  persistenceError?: string;
  persistenceErrorCode?: string;
  terminationError?: string;
  terminationReason?: string;
  cleanupErrors?: string[];
  truncatedFields?: string[];
};
export type JobRecoveryPayload = JobRecoveryDetails & {
  error: "job_recovery_required";
  name: "JobRecoveryError";
  message: string;
};
const requiredStrings = ["jobId", "executionMarker", "marker", "metadataPath", "stdoutPath", "stderrPath", "exitPath"] as const;
const optionalStrings = ["processIdentity", "persistenceError", "persistenceErrorCode", "terminationError", "terminationReason"] as const;
const knownFields = new Set<string>([...requiredStrings, ...optionalStrings, "message", "cleanupErrors"]);

export function jobRecoveryPayload(value: unknown): JobRecoveryPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.error !== "job_recovery_required" || !Number.isSafeInteger(input.pid) || (input.pid as number) <= 0
    || !["stopped", "uncertain"].includes(String(input.processStatus)) || typeof input.terminationVerified !== "boolean"
    || requiredStrings.some(key => typeof input[key] !== "string" || !input[key])) return undefined;
  const truncated = new Set<string>(Array.isArray(input.truncatedFields)
    ? input.truncatedFields.filter((key): key is string => typeof key === "string" && knownFields.has(key)) : []);
  const bounded = (key: string, text: string, budget = 4096) => {
    // Count escaped JSON bytes, so control characters cannot defeat the bound.
    if (Buffer.byteLength(JSON.stringify(text)) <= budget) return text;
    truncated.add(key);
    let low = 0, high = Math.min(text.length, budget);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= budget - 3) low = mid; else high = mid - 1;
    }
    return text.slice(0, low) + "…";
  };
  const output: JobRecoveryPayload = {
    error: "job_recovery_required", name: "JobRecoveryError",
    message: bounded("message", typeof input.message === "string" ? input.message : "Job recovery is required", 1024),
    pid: input.pid as number, processStatus: input.processStatus as JobRecoveryDetails["processStatus"],
    terminationVerified: input.terminationVerified,
    ...Object.fromEntries(requiredStrings.map(key => [key, bounded(key, input[key] as string)])) as Pick<JobRecoveryDetails, typeof requiredStrings[number]>,
  };
  for (const key of optionalStrings) {
    if (typeof input[key] === "string") output[key] = bounded(key, input[key], key === "processIdentity" ? 4096 : 1024);
  }
  if (Array.isArray(input.cleanupErrors)) {
    if (input.cleanupErrors.length > 8) truncated.add("cleanupErrors");
    output.cleanupErrors = input.cleanupErrors.slice(0, 8).filter((item): item is string => typeof item === "string")
      .map(item => bounded("cleanupErrors", item, 1024));
  }
  if (truncated.size) output.truncatedFields = [...truncated];
  return output;
}
