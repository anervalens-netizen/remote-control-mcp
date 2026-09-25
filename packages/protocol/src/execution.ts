import { z } from "zod";
import { timeoutMsField } from "./deadline.ts";

/** Shared by single-command and batch tools: one wire contract, literal environment. */
export const execRequestFields = {
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: timeoutMsField.optional(),
  env: z.record(z.string(), z.string()).optional(),
  maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
};

export const executionRouteFields = {
  identity: z.enum(["owner", "root", "interactive"]),
  context: z.enum(["user", "system", "desktop"]),
};

export const execResultSchema = z.object({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean(),
  cancellationRequested: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
  terminationVerified: z.boolean().optional(),
  terminationForced: z.boolean().optional(),
  drainTimedOut: z.boolean().optional(),
  terminationError: z.string().optional(),
  terminationVerification: z.enum(["identity_bound_job", "posix_identity_set", "partial_windows_job", "unverified_windows_fallback"]).optional(),
  terminationVerificationScope: z.enum(["whole_tree", "root_and_descendants_created_after_attach", "root_only", "unverified"]).optional(),
  terminationReason: z.string().optional(),
}).passthrough();

export const fsReadFields = {
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  length: z.number().int().nonnegative().optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  tailBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional(),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().positive().max(100_000).optional(),
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional(),
};

export const fsReadResultSchema = z.object({
  path: z.string(),
  data: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  bytesRead: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  eof: z.boolean(),
  totalBytes: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  startLine: z.number().int().positive().optional(),
  nextLine: z.number().int().positive().optional(),
  linesRead: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  partialLine: z.boolean().optional(),
}).passthrough();

/** Failed items carry their original index and selected route, even in mixed batches. */
export const batchFailureSchema = z.object({
  index: z.number().int().nonnegative(),
  ok: z.literal(false),
  error: z.string(),
  device: z.string(),
  ...executionRouteFields,
});

export function batchResultSchema<T extends z.ZodType>(resultSchema: T) {
  return z.object({
    items: z.array(z.union([
      z.object({ index: z.number().int().nonnegative(), ok: z.literal(true), device: z.string(), ...executionRouteFields, result: resultSchema }),
      batchFailureSchema,
    ])),
    errors: z.array(batchFailureSchema),
    partial: z.boolean().describe("True when one or more items failed; all dispatched operations have settled before return."),
  });
}
