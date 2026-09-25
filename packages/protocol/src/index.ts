export type DeviceConfig = {
  name: string;
  url: string;
  transport?: "http" | "android-reverse";
  token?: string;
  userUrl?: string;
  userToken?: string;
  desktopUrl?: string;
  desktopToken?: string;
  directUrl?: string;
  userDirectUrl?: string;
  desktopDirectUrl?: string;
};

export type ExecRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
};

export type ExecResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancellationRequested?: boolean;
  cancelled?: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  terminationVerified?: boolean;
  terminationForced?: boolean;
  drainTimedOut?: boolean;
  terminationError?: string;
  terminationVerification?: "identity_bound_job" | "posix_identity_set" | "partial_windows_job" | "unverified_windows_fallback";
  terminationVerificationScope?: "whole_tree" | "root_and_descendants_created_after_attach" | "root_only" | "unverified";
  terminationReason?: string;
};

export { execRequestFields, executionRouteFields, execResultSchema, fsReadFields, fsReadResultSchema, batchFailureSchema, batchResultSchema } from "./execution.ts";
export { DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS, HTTP_GRACE_MS, MAX_DEADLINE_MS, NODE_TIMER_MAX_MS, createDeadline, timeoutMsField, withTimeoutGrace } from "./deadline.ts";
export {
  androidCommandRequestSchema, androidGlobalActionRequestSchema, androidImageSchema,
  androidNodeActionRequestSchema, androidObserveRequestSchema, androidOpenAppRequestSchema,
  androidPollRequestSchema, androidPollResponseSchema, androidResultRequestSchema,
  androidResultResponseSchema, androidSetTextRequestSchema, androidSnapshotSchema,
  androidStateSchema, androidSwipeRequestSchema, androidTapRequestSchema,
} from "./android.ts";
export type { AndroidCommandRequest, AndroidPollRequest, AndroidPollResponse, AndroidResultRequest } from "./android.ts";
