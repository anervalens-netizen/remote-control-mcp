import { z } from "zod";
import { executionOutcomeSchema, executionSummarySchema } from "./execution-outcome.ts";
import { timeoutMsField } from "./deadline.ts";

/** Shared by single-command and batch tools: one wire contract, literal environment. */
export const execRequestFields = {
  execReceiptId: z.string().uuid().optional().describe("Single-use agent-disk reservation from exec_prepare. Retrieve it with exec_recover after disconnect/restart; never reuse to execute."),
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
  requestSucceeded: z.boolean().optional(),
  executionOutcome: executionOutcomeSchema.optional(),
  effectVerification: z.literal("unverified").optional(),
  clientAcceptance: z.literal("unknown").optional(),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdoutReturnedBytes: z.number().int().nonnegative().optional(),
  stderrReturnedBytes: z.number().int().nonnegative().optional(),
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
  agentStdoutTruncated: z.boolean().nullable().optional(),
  agentStderrTruncated: z.boolean().nullable().optional(),
  controllerStdoutTruncated: z.boolean().optional(),
  controllerStderrTruncated: z.boolean().optional(),
  terminationVerified: z.boolean().optional(),
  terminationForced: z.boolean().optional(),
  drainTimedOut: z.boolean().optional(),
  terminationError: z.string().optional(),
  terminationVerification: z.enum(["identity_bound_job", "posix_identity_set", "partial_windows_job", "unverified_windows_fallback"]).optional(),
  terminationVerificationScope: z.enum(["whole_tree", "root_and_descendants_created_after_attach", "root_only", "unverified"]).optional(),
  terminationReason: z.string().optional(),
}).passthrough();

export const sourceVersionSchema = z.string().regex(/^\d+:\d+:\d+:-?\d+:-?\d+$/);

export const fsReadFields = {
  versioned: z.boolean().optional().describe("Verify regular-file identity and nanosecond modification/change times around a byte read. Byte paging only: omit maxBytes, startLine, lineCount and tailBytes."),
  expectedVersion: sourceVersionSchema.optional().describe("Require this sourceVersion; implies versioned even when versioned=false. Byte paging only; a mismatch fails without returning data."),
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional().describe("Byte offset for byte paging, or the returned nextOffset continuation cursor for line reads. Not valid with tailBytes."),
  length: z.number().int().nonnegative().max(64 * 1024 * 1024).optional().describe("Byte paging limit; use this to bound versioned reads. Zero reads metadata only. Cannot be combined with line-range options or tailBytes."),
  encoding: z.enum(["utf8", "base64"]).optional().describe("Byte/tail encoding; defaults to UTF-8. Line-range reads require UTF-8."),
  tailBytes: z.number().int().nonnegative().max(64 * 1024 * 1024).optional().describe("Read at most this many bytes from the end. Cannot be combined with offset, length, line-range options or versioned reads."),
  startLine: z.number().int().positive().optional().describe("Select UTF-8 line mode at this 1-based line; incompatible with length, tailBytes and versioned reads."),
  lineCount: z.number().int().positive().max(100_000).optional().describe("Select UTF-8 line mode with this line count; incompatible with length, tailBytes and versioned reads."),
  maxBytes: z.number().int().positive().max(64 * 1024 * 1024).optional().describe("UTF-8 line mode only: select line mode and cap its bytes. For byte paging or versioned reads use length and omit maxBytes."),
};

export type FsReadInput = z.infer<z.ZodObject<typeof fsReadFields>>;

/** One mode contract for direct callers, agent HTTP and single/batch MCP reads. */
export function fsReadModeIssues(value: FsReadInput) {
  const issues: Array<{ code: "custom"; path: string[]; message: string }> = [];
  const lineMode = value.startLine !== undefined || value.lineCount !== undefined || value.maxBytes !== undefined;
  if (value.tailBytes !== undefined && (value.offset !== undefined || value.length !== undefined || lineMode)) {
    issues.push({ code: "custom", path: ["tailBytes"], message: "tailBytes cannot be combined with byte or line-range options" });
  }
  if (lineMode && (value.length !== undefined || value.tailBytes !== undefined)) {
    issues.push({ code: "custom", path: ["length"], message: "line-range options cannot be combined with length/tail options" });
  }
  if (lineMode && value.encoding === "base64") {
    issues.push({ code: "custom", path: ["encoding"], message: "line-range reads require UTF-8 encoding" });
  }
  if ((value.versioned === true || value.expectedVersion !== undefined) && (lineMode || value.tailBytes !== undefined)) {
    issues.push({ code: "custom", path: [value.expectedVersion !== undefined ? "expectedVersion" : "versioned"], message: "Versioned reads require byte paging; use length and omit maxBytes, startLine, lineCount and tailBytes" });
  }
  return issues;
}

export function refineFsReadInput(value: FsReadInput, ctx: z.RefinementCtx) {
  for (const issue of fsReadModeIssues(value)) ctx.addIssue(issue);
}

export const fsReadSchema = z.object(fsReadFields).superRefine(refineFsReadInput);

export const fsReadResultSchema = z.object({
  sourceVersion: sourceVersionSchema.optional(),
  modifiedAt: z.string().datetime().optional(),
  posixMode: z.number().int().min(0).max(0o777).nullable().optional(),
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
}).passthrough();

export function batchResultSchema<T extends z.ZodType>(resultSchema: T) {
  return z.object({
    items: z.array(z.union([
      z.object({ index: z.number().int().nonnegative(), ok: z.literal(true), device: z.string(), ...executionRouteFields, result: resultSchema }),
      batchFailureSchema,
    ])),
    errors: z.array(batchFailureSchema),
    summary: executionSummarySchema.optional(),
    executionPartial: z.boolean().optional(),
    totalItems: z.number().int().nonnegative().optional(),
    previewItems: z.number().int().nonnegative().optional(),
    partial: z.boolean().describe("True when one or more items failed; all dispatched operations have settled before return."),
  });
}
