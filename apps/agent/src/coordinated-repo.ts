import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoordinationRecordView as CoordinationRecord, CoordinationToken } from "../../../packages/protocol/src/coordination.ts";
import { CoordinationError, coordinationHash, coordinationPublicRecord, coordinationRecoveryView, type ReconciliationJobEvidence, type ResourceCoordinator, type ResourceVersion } from "./coordination.ts";
import { executionBoundary } from "./execution-boundary.ts";
import { jobStart, jobStartKeyStatus, jobCoordinationStatus } from "./jobs.ts";
import { jobFollow } from "./job-follow.ts";
import { jobStartFingerprint } from "./job-start-dedup.ts";
import { inspectJobUnitForCleanup, jobCgroupEmpty, jobCgroupIsolation, jobUnitName } from "./job-systemd.ts";
import { nativeCommand } from "./shell-quote.ts";
import { atomicWriteJson } from "./state.ts";
import { repoOperationRequestSchema, repoOperationResultSchema, type RepoOperation } from "./repo-operation-contract.ts";

export function coordinatedRepoMode() {
  const containment = jobCgroupIsolation();
  return containment.ready
    ? { recoveryMode: "durable_job" as const, containment: "systemd_cgroup" as const }
    : { recoveryMode: "legacy" as const, containment: "unverified" as const, recoveryLimitation: containment.reason };
}

/** The status enum alone is insufficient on uncontained backends and old tombstones. */
export async function coordinationJobEvidence(id: string): Promise<ReconciliationJobEvidence> {
  const status = await jobCoordinationStatus(id);
  if (!["completed", "cancelled", "lost"].includes(status.state)) throw new CoordinationError("execution_not_terminal");
  if (!("systemdUnit" in status) || status.systemdUnit !== jobUnitName(id) || !status.systemdInvocation || !status.systemdCgroup
    || !status.processIdentity?.startsWith("linux:") || !Number.isSafeInteger(status.pid) || status.pid <= 0) throw new CoordinationError("termination_unverified");
  const unit = await inspectJobUnitForCleanup(id);
  // RemainAfterExit units can retain the same invocation in active/exited after
  // systemd has removed their empty cgroup and cleared ControlGroup. Use the
  // admitted cgroup's authoritative emptiness; a blank current path alone is no proof.
  const terminalEmptyPath = unit.state === "present" && unit.unit.cgroup === "" &&
    (unit.unit.active === "active" && unit.unit.sub === "exited" || unit.unit.active === "inactive" && unit.unit.sub === "dead");
  if (unit.state === "unknown" || unit.state === "present" && (unit.unit.invocation !== status.systemdInvocation
    || unit.unit.cgroup !== status.systemdCgroup && !terminalEmptyPath || ["activating", "reloading"].includes(unit.unit.active))
    || jobCgroupEmpty(id, status.systemdCgroup) !== true) throw new CoordinationError("termination_unverified");
  return { id, device: status.device, identity: status.identity, state: status.state as "completed" | "cancelled" | "lost", containmentVerified: true, exitCode: status.exitCode,
    evidenceHash: coordinationHash([id, status.device, status.identity, status.pid, status.processIdentity, status.systemdInvocation, status.systemdCgroup, status.state, status.exitCode ?? null, unit.state]) };
}
export function repositoryExecutionOutcome(evidence: Pick<ReconciliationJobEvidence, "state" | "exitCode">) {
  if (evidence.state === "cancelled") return "cancelled" as const;
  if (evidence.state !== "completed" || !Number.isInteger(evidence.exitCode)) return "uncertain" as const;
  return evidence.exitCode === 0 ? "exit_zero" as const : "exit_nonzero" as const;
}

export async function coordinatedRepoEvidence(record: CoordinationRecord): Promise<ReconciliationJobEvidence> {
  if (!record.execution) throw new CoordinationError("execution_binding_unavailable", record);
  const key = await jobStartKeyStatus(record.execution.key);
  if (!("fingerprint" in key) || key.fingerprint !== record.execution.fingerprint || !("jobId" in key) || !key.jobId
    || record.jobId && record.jobId !== key.jobId) throw new CoordinationError("execution_receipt_unavailable", record);
  const evidence = await coordinationJobEvidence(key.jobId);
  return { ...evidence, key: record.execution.key, fingerprint: key.fingerprint };
}

function readResult(file: string, requestHash: string) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Repository result unavailable");
    const result = repoOperationResultSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (result.requestHash !== requestHash) throw new Error("Repository result binding mismatch");
    return result;
  } finally { closeSync(fd); }
}

export async function runCoordinatedRepo(options: {
  operation: RepoOperation; input: Record<string, unknown>; token: CoordinationToken;
  coordinator: ResourceCoordinator; resource: ResourceVersion; probe: (pinnedPath: string) => Promise<ResourceVersion>;
}) {
  return executionBoundary(async submit => {
    const { operation, input, token, coordinator, resource } = options;
    const { coordination: _coordination, dryRun: _dryRun, ...fields } = input;
    const pinnedPath = await realpath(String(input.path));
    const request = repoOperationRequestSchema.parse({ version: 1, operation, token, device: resource.device, identity: resource.identity, canonicalKey: resource.canonicalKey, input: { ...fields, path: pinnedPath } });
    if (Buffer.byteLength(JSON.stringify(request)) > 64 * 1024) throw new Error("Repository request exceeds receipt budget");
    const directory = path.join(coordinator.root, "repo-operations", token.operationId);
    const requestFile = path.join(directory, "request.json"), resultFile = path.join(directory, "result.json");
    const requestHash = coordinationHash(request);
    const worker = fileURLToPath(new URL("./repo-operation-worker.ts", import.meta.url));
    const jobInput = { command: nativeCommand([process.execPath, worker, requestFile, resultFile, requestHash]), cwd: request.input.path,
      idempotencyKey: "coordination-repo:" + token.operationId };
    coordinator.bindExecution(token, { kind: "repo_job", key: jobInput.idempotencyKey, fingerprint: jobStartFingerprint(jobInput), requestHash });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteJson(requestFile, request);
    // The complete operation is one existing durable job. Once reserved, an
    // admission failure or missing reply never falls back to direct Git/spawn.
    submit();
    const job = await jobStart(jobInput);
    let record = coordinator.attachJob(token, job.id);
    const followed = await jobFollow({ id: job.id, until: "complete", waitMs: Math.min(20_000, (request.input.timeoutMs ?? 60_000) + 2000), maxBytes: 1024 });
    const recovery = { recoveryMode: "durable_job", noReplay: true, jobId: job.id, effectVerification: "unverified" };
    if (!followed.terminal) return { statusCode: 202, body: { ok: false, accepted: true, operation, executionPending: true, ...recovery,
      job: { id: job.id, state: followed.state }, coordination: { ...coordinationPublicRecord(record), token }, recovery: coordinationRecoveryView(record), nextAction: "Inspect the original job, then reconcile this token and the freshly observed base; do not repeat the repository operation." } };
    const evidence = await coordinatedRepoEvidence(record);
    const executionOutcome = repositoryExecutionOutcome(evidence);
    const observed = await options.probe(pinnedPath);
    const reconciled = coordinator.reconcileJob(token, observed, observed.baseVersion, evidence);
    record = reconciled.record;
    let result;
    try { result = readResult(resultFile, requestHash); }
    catch { return { statusCode: 500, body: { ok: false, operation, error: "repository_result_unavailable", resultPublication: "unavailable", executionOutcome,
      ...recovery, coordination: { ...coordinationPublicRecord(record), token }, recovery: coordinationRecoveryView(record) } }; }
    const succeeded = result.ok && executionOutcome === "exit_zero";
    return { statusCode: succeeded ? 200 : 500, body: { ...(result.result ?? {}), ok: succeeded, operation, operationSucceeded: result.ok, resultPublication: "available",
      ...(result.error ? { error: "repository_operation_failed", message: result.error } : !succeeded ? { error: "repository_execution_outcome_unverified" } : {}), ...recovery,
      executionOutcome, coordination: { ...coordinationPublicRecord(record), token }, recovery: coordinationRecoveryView(record) } };
  });
}
