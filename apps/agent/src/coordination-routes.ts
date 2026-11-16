import { noEffectSubmittedProof, withExecutionProof } from "./execution-boundary.ts";
import path from "node:path";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isCoordinationReadOnly, coordinationRequestSchema, coordinationResourceSchema, coordinationTokenSchema, type CoordinationResource } from "../../../packages/protocol/src/coordination.ts";
import { ResourceCoordinator, CoordinationError, coordinationFileMode, coordinationToken, coordinationHash, coordinationDevice, coordinationIdentity, coordinationPublicRecord, coordinationRecoveryView } from "./coordination.ts";
import type { CoordinationRecordView } from "../../../packages/protocol/src/coordination.ts";
import { resolveCoordinationResource } from "./coordination-resource.ts";
import { stateRoot } from "./state.ts";
import { jobStartKeyStatus, jobCoordinationStatus } from "./jobs.ts";
import { coordinatedRepoMode, runCoordinatedRepo, coordinatedRepoEvidence, coordinationJobEvidence } from "./coordinated-repo.ts";
import type { RepoOperation } from "./repo-operation-contract.ts";

export function operationResource(route: string, input: Record<string, unknown>): CoordinationResource | null {
  if (isCoordinationReadOnly(route, input)) return null;
  if (route === "/v1/service") return coordinationResourceSchema.parse({ kind: "service", name: input.name, scope: input.scope });
  const target = route === "/v1/deploy/run" ? input.repoPath ?? input.cwd : input.path;
  if (route === "/v1/deploy/run" && target === undefined) return null;
  return coordinationResourceSchema.parse({ kind: "repo", path: target });
}
function recoveryReply<T extends { record: CoordinationRecordView }>(result: T) {
  return { ...result, record: coordinationPublicRecord(result.record), recovery: coordinationRecoveryView(result.record) };
}

/** Installed before the high-level routes. Raw exec, jobs and reads do not use this lane. */
export function registerCoordinationRoutes(app: FastifyInstance) {
  const root = process.env.RCMCP_COORDINATION_DIR ?? path.join(stateRoot, "coordination");
  if (!path.isAbsolute(root)) throw new Error("RCMCP_COORDINATION_DIR must be absolute");
  const coordinator = new ResourceCoordinator(root, 4, Date.now, coordinationFileMode(process.env.RCMCP_COORDINATION_FILE_MODE));
  let probes = 0;
  async function probe(resource: CoordinationResource) {
    if (probes >= 4) throw new CoordinationError("probe_backpressure");
    probes++;
    try { return await resolveCoordinationResource(resource); } finally { probes--; }
  }
  async function reconcile() {
    // At most four active jobs per device. Missing evidence remains blocking.
    for (const record of coordinator.activeRecords()) {
      if (record.execution || !record.jobId || record.device !== coordinationDevice || record.identity !== coordinationIdentity) continue;
      try {
        const job = await jobCoordinationStatus(record.jobId);
        if (job.state === "completed" || job.state === "cancelled" || job.state === "lost") {
          coordinator.settle(coordinationToken(record), { jobEvidence: { id: job.id, device: job.device, identity: job.identity, state: job.state } });
        }
      } catch { /* Different identity or unavailable job: never release by age. */ }
    }
  }
  app.post("/v1/coordination", async (request, reply) => {
    const parsed = coordinationRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      // Recovery actions must not pass through the older, less specific job
      // settlement policy before checking their own containment/boot evidence.
      if (parsed.data.action === "acquire" || parsed.data.action === "release") await reconcile();
      const input = parsed.data, resource = await probe(input.resource);
      if (input.action === "inspect") return coordinator.inspect(resource);
      if (input.action === "inspect_recovery") return coordinator.inspectRecovery(resource);
      if (input.action === "release") {
        if (!input.token || input.token.resourceId !== coordinator.resourceId(resource)) throw new CoordinationError("resource_token_required");
        return { record: coordinator.release(input.token) };
      }
      if (input.action === "prepare_recovery" || input.action === "reconcile") {
        if (!input.token || input.token.resourceId !== coordinator.resourceId(resource)) throw new CoordinationError("resource_token_required");
        if (!input.expectedCurrentBaseVersion) throw new CoordinationError("expected_current_base_required");
        if (input.action === "prepare_recovery") return recoveryReply(coordinator.prepareRecovery(input.token, resource, input.expectedCurrentBaseVersion));
        const previous = coordinator.reconciled(input.token, resource, input.expectedCurrentBaseVersion, input.recoveryIntentId);
        if (previous) return recoveryReply(previous);
        const record = coordinator.current(resource);
        if (!record || coordinationHash(coordinationToken(record)) !== coordinationHash(input.token)) throw new CoordinationError("stale_writer", record);
        if (input.recoveryIntentId) {
          const evidence = record.jobId ? await coordinationJobEvidence(record.jobId).catch(() => undefined) : undefined;
          const current = await probe(input.resource);
          return recoveryReply(coordinator.reconcileRecovery(input.token, current, input.expectedCurrentBaseVersion, input.recoveryIntentId, evidence));
        }
        const evidence = await coordinatedRepoEvidence(record);
        const current = await probe(input.resource);
        return recoveryReply(coordinator.reconcileJob(input.token, current, input.expectedCurrentBaseVersion, evidence));
      }
      const record = coordinator.acquire(resource, input.leaseMs, input.ownerOverride);
      return { record, token: coordinationToken(record) };
    } catch (error) { if (error instanceof CoordinationError) return reply.code(409).send(error.toJSON()); throw error; }
  });
  return async function coordinate(route: string, request: FastifyRequest, reply: FastifyReply, input: Record<string, unknown>, run: () => unknown | Promise<unknown>) {
      // The caller passes the same schema-validated input used for execution.
      const proofScope = Symbol();
      let token;
      let began = false;
      let automatic = false;
      let repoMode: ReturnType<typeof coordinatedRepoMode> | undefined;
      try {
        const resourceInput = operationResource(route, input);
        if (!resourceInput) {
          if (input.coordination !== undefined) throw new CoordinationError("resource_unavailable_or_read_only");
          return await run();
        }
        // Keyed recovery retains the original fingerprint validation and performs
        // no fresh dispatch. Mutable resource probes must not break that invariant.
        if ((route === "/v1/project/run" || route === "/v1/deploy/run") && typeof input.idempotencyKey === "string") {
          const previous = await jobStartKeyStatus(input.idempotencyKey);
          if (previous.state !== "not_found") return await run();
        }
        await reconcile();
        const base = await probe(resourceInput);
        const supplied = input.coordination === undefined ? null : coordinationTokenSchema.parse(input.coordination);
        token = supplied ?? undefined;
        if (request.raw.aborted || reply.raw.destroyed) throw new CoordinationError("cancelled_before_apply");
        automatic = !supplied;
        token = supplied ?? coordinationToken(coordinator.acquire(base));
        // Re-observe after admission: neither a token nor an override bypasses CAS.
        const current = await probe(resourceInput);
        coordinator.begin(token, current);
        began = true;
        if (request.raw.aborted || reply.raw.destroyed) {
          coordinator.settle(token);
          began = false;
          throw new CoordinationError("cancelled_before_apply");
        }
        if (["/v1/repo/fetch", "/v1/repo/pull", "/v1/repo/push"].includes(route)) {
          // Select the backend before any execution reservation. Never fall back
          // after this branch has persisted a job binding or attempted admission.
          repoMode = coordinatedRepoMode();
          if (repoMode.recoveryMode === "durable_job") {
            const outcome = await withExecutionProof(proofScope, () => runCoordinatedRepo({ operation: route.slice("/v1/repo/".length) as RepoOperation,
              input, token: token!, coordinator, resource: current, probe: pinnedPath => probe({ kind: "repo", path: pinnedPath }) }));
            return reply.code(outcome.statusCode).send(outcome.body);
          }
        }
        const result = await withExecutionProof(proofScope, run) as Record<string, unknown> | undefined;
        if (result === reply as unknown) { coordinator.settle(token, { uncertain: reply.statusCode >= 500 }); return reply; }
        const job = (route === "/v1/deploy/run" ? result?.job : route === "/v1/project/run" && input.mode !== "exec" ? result?.result : undefined) as { id?: string } | undefined;
        const execution = result?.result as { cancelled?: boolean; cancellationRequested?: boolean; timedOut?: boolean; terminationVerified?: boolean } | undefined;
        const uncertain = reply.statusCode >= 500 || Boolean(execution && (execution.cancelled || execution.cancellationRequested || execution.timedOut) && !execution.terminationVerified);
        const record = coordinator.settle(token, { jobId: job?.id, uncertain });
        return result && typeof result === "object" ? { ...result, ...(repoMode ?? {}), coordination: { ...coordinationPublicRecord(record), token: coordinationToken(record) } } : result;
      } catch (error) {
        let failedRecord;
        if (token && began) {
          // Only this invocation's successful begin authorizes settlement. A
          // rejected duplicate must never settle the active invocation's token.
          try { failedRecord = coordinator.settle(token, { uncertain: !noEffectSubmittedProof(error, proofScope) }); } catch { /* not active */ }
        } else if (token && (automatic || error instanceof CoordinationError && error.reason === "cancelled_before_apply")) {
          // No invocation began an effect. Release only a matching reservation;
          // a stale/duplicate token cannot release an active or newer writer.
          try { coordinator.release(token); } catch { /* no matching reservation */ }
        }
        if (error instanceof CoordinationError) return reply.code(409).send({ ...(failedRecord ? new CoordinationError(error.reason, failedRecord) : error).toJSON(), ...(repoMode ?? {}) });
        if (repoMode && failedRecord) return reply.code(500).send({ error: "repository_operation_failed",
          message: repoMode.recoveryMode === "legacy" && error instanceof Error ? error.message : "Repository execution requires recovery; inspect the original receipt without replay.",
          ...repoMode, noReplay: true, effectVerification: "unverified", coordination: { ...coordinationPublicRecord(failedRecord), token }, recovery: coordinationRecoveryView(failedRecord) });
        throw error;
      }
  };
}
