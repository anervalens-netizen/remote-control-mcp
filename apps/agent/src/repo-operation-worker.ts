import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { coordinationHash, coordinationDevice, coordinationIdentity, coordinationToken, ResourceCoordinator } from "./coordination.ts";
import { resolveCoordinationResource } from "./coordination-resource.ts";
import { JobStartDeduplicator } from "./job-start-dedup.ts";
import { repoFetch, repoPull, repoPush, redactGitText } from "./repo.ts";
import { atomicWriteJson, stateRoot } from "./state.ts";
import { repoOperationRequestSchema, repoOperationResultSchema } from "./repo-operation-contract.ts";

// One durable job owns the complete high-level operation, including pre/post
// observations and result publication. Never dispatch another job per Git step.
const [requestFile, resultFile, expectedHash] = process.argv.slice(2);
if (!requestFile || !resultFile || !expectedHash) throw new Error("Missing repository operation receipt");
const fd = openSync(requestFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
let request;
try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid repository operation receipt");
  request = repoOperationRequestSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
} finally { closeSync(fd); }
if (coordinationHash(request) !== expectedHash || request.device !== coordinationDevice || request.identity !== coordinationIdentity) throw new Error("Repository operation binding mismatch");
try {
  // Admission is asynchronous. Revalidate the pinned path and original fence in
  // this worker immediately before the high-level operation, not only in HTTP.
  const observed = await resolveCoordinationResource({ kind: "repo", path: request.input.path });
  if (observed.device !== request.device || observed.identity !== request.identity || observed.canonicalKey !== request.canonicalKey || observed.baseVersion !== request.token.baseVersion) throw new Error("Repository resource or base changed before execution");
  const coordinator = new ResourceCoordinator(path.resolve(path.dirname(requestFile), "../.."));
  const record = coordinator.current(observed);
  if (!record || record.state !== "active" || coordinationHash(coordinationToken(record)) !== coordinationHash(request.token)
    || record.execution?.requestHash !== expectedHash || record.execution.key !== "coordination-repo:" + request.token.operationId) throw new Error("Repository execution fence changed before execution");
  const reservation = new JobStartDeduplicator(path.join(stateRoot, "job-start-keys")).lookup(record.execution.key);
  if (reservation.state !== "reserved" || reservation.fingerprint !== record.execution.fingerprint || reservation.jobId !== process.env.RCMCP_JOB_ID
    || record.jobId && record.jobId !== reservation.jobId) throw new Error("Repository durable job binding changed before execution");
  const run = request.operation === "fetch" ? repoFetch : request.operation === "pull" ? repoPull : repoPush;
  const result = await run(request.input);
  atomicWriteJson(resultFile, repoOperationResultSchema.parse({ version: 1, requestHash: expectedHash, ok: true, result }));
} catch (error) {
  const detail = redactGitText(error instanceof Error ? error.message : String(error)).slice(0, 40 * 1024);
  atomicWriteJson(resultFile, repoOperationResultSchema.parse({ version: 1, requestHash: expectedHash, ok: false, error: detail }));
  process.exitCode = 1;
}
