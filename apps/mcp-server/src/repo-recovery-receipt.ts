import { z } from "zod";
import { coordinationExecutionSchema, coordinationHookFailureSchema, coordinationRecordSchema, coordinationRecoveryViewSchema, coordinationTokenSchema } from "../../../packages/protocol/src/coordination.ts";

const repoRoutes = new Map<string, "fetch" | "pull" | "push">([
  ["/v1/repo/fetch", "fetch"], ["/v1/repo/pull", "pull"], ["/v1/repo/push", "push"],
]);
const jobSchema = z.object({ id: z.string().uuid(), state: z.enum(["running", "cancelling", "completed", "cancelled", "lost"]) }).strict();
const metadata = {
  recoveryMode: z.literal("durable_job"), noReplay: z.literal(true), effectVerification: z.literal("unverified"),
  operation: z.enum(["fetch", "pull", "push"]).optional(),
  jobId: z.string().uuid().optional(), job: jobSchema.optional(),
  coordination: coordinationRecordSchema.extend({ token: coordinationTokenSchema }).strict(),
  recovery: coordinationRecoveryViewSchema.optional(),
  executionOutcome: z.enum(["exit_zero", "exit_nonzero", "signal", "timeout", "cancelled", "uncertain", "not_started"]).optional(),
  operationSucceeded: z.boolean().optional(),
  resultPublication: z.enum(["available", "unavailable"]).optional(),
};
const rawReceiptSchema = z.object(metadata); // Strip unknown fields; never forward arbitrary error payloads.
type Receipt = z.infer<typeof rawReceiptSchema>;

function checkBindings(receipt: Pick<Receipt, "coordination" | "jobId" | "job" | "recovery">, context: z.RefinementCtx) {
  const record = receipt.coordination;
  if (record.resourceId !== record.token.resourceId || record.operationId !== record.token.operationId ||
      record.generation !== record.token.generation || record.baseVersion !== record.token.baseVersion) {
    context.addIssue({ code: "custom", message: "Repository coordination token mismatch" });
  }
  const jobs = [receipt.jobId, receipt.job?.id, record.jobId, receipt.recovery?.resolution?.jobId].filter(id => id !== undefined);
  if (jobs.some(id => id !== jobs[0])) context.addIssue({ code: "custom", message: "Repository job locator mismatch" });
  if (receipt.recovery?.execution && receipt.recovery.execution.key !== `coordination-repo:${record.operationId}`) {
    context.addIssue({ code: "custom", message: "Repository execution binding mismatch" });
  }
}
const receiptSchema = rawReceiptSchema.superRefine(checkBindings);
const legacyReceiptSchema = z.object({
  recoveryMode: z.literal("legacy"), containment: z.literal("unverified"),
  recoveryLimitation: z.enum(["unsupported_platform", "disabled", "cgroup_v2_unavailable", "systemd_user_unavailable", "systemd_system_unavailable"]),
  noReplay: z.literal(true), effectVerification: z.literal("unverified"), operation: metadata.operation,
  coordination: metadata.coordination, recovery: metadata.recovery,
  // Legacy execution does not acquire durable-job authority from payload fields.
  jobId: z.never().optional(), job: z.never().optional(),
}).superRefine(checkBindings);
const anyReceiptSchema = z.union([receiptSchema, legacyReceiptSchema]);
export type RepoRecoveryReceipt = z.infer<typeof anyReceiptSchema>;

/** Accept bounded recovery metadata only from the three audited repository routes.
 * A locator is correlation evidence, never proof that a process has terminated.
 */
export function repoRecoveryReceipt(route: string, value: unknown): RepoRecoveryReceipt | undefined {
  const operation = repoRoutes.get(route);
  if (!operation) return undefined;
  const parsed = anyReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.operation !== undefined && parsed.data.operation !== operation) return undefined;
  const receipt = parsed.data;
  if (receipt.recoveryMode === "legacy") return receipt;
  const jobId = receipt.jobId ?? receipt.job?.id ?? receipt.coordination.jobId ?? receipt.recovery?.resolution?.jobId;
  return { ...receipt, ...(jobId ? { jobId } : {}) };
}

const checkpointFailureSchema = z.object({
  error: z.literal("repository_commit_failed"),
  noReplay: z.literal(true),
  effectVerification: z.literal("unverified"),
  hookFailure: coordinationHookFailureSchema,
  evidencePublication: z.enum(["available", "unavailable"]),
});

/** The checkpoint error needs only a compact locator hint. Inspect the
 * original repository recovery record for the complete bounded observation. */
export function checkpointFailureReceipt(route: string, status: number, value: unknown) {
  if (route !== "/v1/repo/checkpoint" || status !== 500) return undefined;
  const parsed = checkpointFailureSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { hookFailure, evidencePublication } = parsed.data;
  return {
    commandExitCode: hookFailure.hook.exitCode,
    classification: hookFailure.classification,
    observedAt: hookFailure.observedAt,
    evidencePublication,
    nextAction: "Inspect the same repository and identity with resource_coordination action=inspect_recovery. Preserve the original writer fence and do not repeat the checkpoint.",
  };
}
export type CheckpointFailureReceipt = NonNullable<ReturnType<typeof checkpointFailureReceipt>>;

/** Pending is its own result alternative. It must not weaken completed success
 * fields or claim process/application success before a later authoritative read.
 */
export function repoPendingResultSchema(operation: "fetch" | "pull" | "push") {
  return z.object({
    ...metadata, operation: z.literal(operation), ok: z.literal(false), accepted: z.literal(true), executionPending: z.literal(true),
    jobId: z.string().uuid(), job: jobSchema,
    recovery: coordinationRecoveryViewSchema.extend({ execution: coordinationExecutionSchema, resolution: z.null() }),
    executionOutcome: z.never().optional(), operationSucceeded: z.never().optional(),
    nextAction: z.string().min(1).max(2048),
  }).strict().superRefine(checkBindings);
}
