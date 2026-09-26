import { JobStartKeyError } from "./job-start-dedup.ts";
import { powerSchema,wakeSchema } from "../../../packages/protocol/src/power.ts";
import { sendWake } from "../../../packages/shared/src/wake.ts";
import { projectRun } from "./project-run.ts";
import { projectFields, projectRunFields, deployFields, jobFollowFields, jobLineageSchema } from "../../../packages/protocol/src/project.ts";
import { deployRun } from "./deploy.ts";
import { jobFollow } from "./job-follow.ts";
import { repoCheckpointFields, repoPatchFields, fsEditFields } from "../../../packages/protocol/src/editing.ts";
import { repoApplyPatch } from "./repo-edit.ts";
import { fsEdit } from "./fs-edit.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { search } from "./search.ts";
import { SearchInputError } from "./search-common.ts";
import { searchRemove, searchResults, searchSessions, searchStart, searchStop } from "./search-sessions.ts";
import { serviceLogs, serviceManage, systemMetrics } from "./system.ts";
import { JobRecoveryError, jobCancel, jobLineage, jobListAsync, jobOutput, jobRemove, jobStart, jobStatusAsync } from "./jobs.ts";
import { repoCheckpoint, repoFetch, repoGitPath, repoPull, repoPush, repoSnapshot } from "./repo.ts";
import { dockerSnapshot, dockerSummary } from "./docker.ts";
import { findProcesses } from "./processes.ts";
import { projectPlan } from "./project.ts";
import { gpuSnapshot, hostPower, networkSnapshot, packageManage, packageManagers, storageSnapshot } from "./host.ts";

const searchSchema = z.object({
  path: z.string().min(1), pattern: z.string(), mode: z.enum(["content", "files"]).optional(),
  literal: z.boolean().optional(), ignoreCase: z.boolean().optional(), hidden: z.boolean().optional(),
  glob: z.string().optional(), globs: z.array(z.string()).max(256).optional(),
  types: z.array(z.string().min(1)).max(256).optional(), excludeTypes: z.array(z.string().min(1)).max(256).optional(),
  follow: z.boolean().optional(), noIgnore: z.boolean().optional(), maxFileSizeBytes: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
});
const searchResultsSchema = z.object({
  id: z.string().min(1), offset: z.number().int().nonnegative().optional(),
  length: z.number().int().positive().max(1000).optional(), cursor: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional(),
});
const searchStopSchema = z.object({ id: z.string().min(1) });
const searchRemoveSchema = z.object({ id: z.string().min(1), force: z.boolean().optional() });
const serviceSchema = z.object({
  name: z.string().min(1), action: z.enum(["status", "start", "stop", "restart", "enable", "disable"]),
  scope: z.enum(["user", "system"]).optional(),
});


const repoSnapshotSchema = z.object({ path: z.string().min(1), logCount: z.number().int().positive().max(50).optional(), profile: z.enum(["summary", "full"]).optional() });
const processFindSchema = z.object({ query: z.string().optional(), pid: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() });
const dockerSummarySchema = z.object({ query: z.string().optional(), state: z.enum(["all", "running", "stopped"]).optional(), limit: z.number().int().min(1).max(200).optional() });
const metricsQuerySchema = z.object({ profile: z.enum(["light", "full"]).optional() });
const repoCheckpointSchema = z.object(repoCheckpointFields);
const repoGitPathSchema = z.object({ path: z.string().min(1), gitPath: z.string().min(1) });
const repoFetchSchema = z.object({
  path: z.string().min(1), remote: z.string().min(1).optional(), refspecs: z.array(z.string().min(1)).max(32).optional(),
  prune: z.boolean().optional(), tags: z.boolean().optional(), timeoutMs: z.number().int().positive().max(600_000).optional(),
});
const repoPullSchema = z.object({
  path: z.string().min(1), remote: z.string().min(1).optional(), refspecs: z.array(z.string().min(1)).max(32).optional(),
  ffOnly: z.boolean().optional(), tags: z.boolean().optional(), timeoutMs: z.number().int().positive().max(600_000).optional(),
});
const repoPushSchema = z.object({
  path: z.string().min(1), remote: z.string().min(1).optional(), refspecs: z.array(z.string().min(1)).max(32).optional(),
  setUpstream: z.boolean().optional(), tags: z.boolean().optional(), dryRun: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});
const projectPlanSchema = z.object(projectFields);

const jobStartSchema = z.object({ command: z.string().min(1), cwd: z.string().optional(), idempotencyKey: z.string().min(1).max(200).optional(), env: z.record(z.string(), z.string()).optional() });
const jobIdSchema = z.object({ id: z.string().min(1) });
const jobOutputSchema = z.object({
  id: z.string().min(1), stream: z.enum(["stdout", "stderr"]).optional(), offset: z.number().int().optional(),
  length: z.number().int().positive().max(1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional(),
});
const jobRemoveSchema = z.object({ id: z.string().min(1), force: z.boolean().optional() });

const packageSchema = z.object({ manager: z.string().optional(), action: z.enum(["list", "search", "install", "upgrade", "remove"]), packages: z.array(z.string().min(1)).optional(), all: z.boolean().optional(), timeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional() });

const logsSchema = z.object({
  name: z.string().min(1), scope: z.enum(["user", "system"]).optional(),
  lines: z.number().int().positive().optional(),
});

function searchInputFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof SearchInputError) {
    return reply.code(400).send({
      error: "invalid_argument",
      kind: error.kind,
      message: error.message,
      ...(error.suggestion ? { suggestion: error.suggestion } : {}),
    });
  }
  throw error;
}

export function registerExtraRoutes(app: FastifyInstance): void {
  app.post("/v1/search", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    try { return await search(parsed.data); }
    catch (error) { return searchInputFailure(reply, error); }
  });
  app.post("/v1/search/start", async (request, reply) => {
    const parsed = searchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    try { return await searchStart(parsed.data); }
    catch (error) { return searchInputFailure(reply, error); }
  });
  app.post("/v1/search/results", async (request, reply) => {
    const parsed = searchResultsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return searchResults(parsed.data.id, parsed.data.offset, parsed.data.length, parsed.data.cursor, parsed.data.maxBytes);
  });
  app.post("/v1/search/stop", async (request, reply) => {
    const parsed = searchStopSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return searchStop(parsed.data.id);
  });
  app.get("/v1/search/sessions", async () => searchSessions());
  app.post("/v1/search/remove", async (request, reply) => { const parsed = searchRemoveSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues }); return searchRemove(parsed.data.id, parsed.data.force); });
  app.post("/v1/service", async (request, reply) => {
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return serviceManage(parsed.data);
  });
  app.post("/v1/service/logs", async (request, reply) => {
    const parsed = logsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return serviceLogs(parsed.data);
  });

  app.post("/v1/jobs/start", async (request, reply) => {
    const parsed = jobStartSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    try { return await jobStart(parsed.data); }
    catch (error) {
      if (error instanceof JobRecoveryError) return reply.code(500).send(error.toJSON());
      if (error instanceof JobStartKeyError) return reply.code(409).send({error:error.code,message:error.message,jobId:error.jobId});
      throw error;
    }
  });
  app.post("/v1/jobs/lineage", async (request, reply) => {
    const parsed = jobLineageSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return jobLineage(parsed.data);
  });
  app.post("/v1/jobs/status", async (request, reply) => {
    const parsed = jobIdSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return jobStatusAsync(parsed.data.id);
  });
  app.post("/v1/jobs/output", async (request, reply) => {
    const parsed = jobOutputSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return jobOutput(parsed.data);
  });
  app.post("/v1/jobs/cancel", async (request, reply) => {
    const parsed = jobIdSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return jobCancel(parsed.data.id);
  });
  app.post("/v1/jobs/remove", async (request, reply) => {
    const parsed = jobRemoveSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return jobRemove(parsed.data.id, parsed.data.force);
  });
  app.get("/v1/jobs", async (request) => { const q = request.query as { limit?: string }; return jobListAsync(q.limit ? Number(q.limit) : undefined); });

  app.post("/v1/repo/snapshot", async (request, reply) => {
    const parsed = repoSnapshotSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return parsed.data.profile === "summary"
      ? repoSnapshot(parsed.data.path, parsed.data.logCount, "summary")
      : repoSnapshot(parsed.data.path, parsed.data.logCount, "full");
  });
  app.post("/v1/repo/checkpoint", async (request, reply) => {
    const parsed = repoCheckpointSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoCheckpoint(parsed.data);
  });
  app.post("/v1/repo/apply-patch", async (request, reply) => {
    const parsed = z.object(repoPatchFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoApplyPatch(parsed.data);
  });
  app.post("/v1/fs/edit", async (request, reply) => {
    const parsed = z.object(fsEditFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return fsEdit(parsed.data);
  });
  app.post("/v1/repo/git-path", async (request, reply) => {
    const parsed = repoGitPathSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoGitPath(parsed.data.path, parsed.data.gitPath);
  });
  app.post("/v1/repo/fetch", async (request, reply) => {
    const parsed = repoFetchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoFetch(parsed.data);
  });
  app.post("/v1/repo/pull", async (request, reply) => {
    const parsed = repoPullSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoPull(parsed.data);
  });
  app.post("/v1/repo/push", async (request, reply) => {
    const parsed = repoPushSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return repoPush(parsed.data);
  });
  app.post("/v1/processes/find", async (request, reply) => { const p=processFindSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return findProcesses(p.data); });
  app.get("/v1/docker/snapshot", async () => dockerSnapshot());
  app.post("/v1/docker/summary", async (request, reply) => { const p=dockerSummarySchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return dockerSummary(p.data); });
  app.post("/v1/deploy/run", async (request, reply) => {
    const parsed = z.object(deployFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    try { return await deployRun(parsed.data); }
    catch (error) {
      if (error instanceof JobRecoveryError) return reply.code(500).send(error.toJSON());
      throw error;
    }
  });
  app.post("/v1/jobs/follow", async (request, reply) => {
    const parsed = z.object(jobFollowFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const controller = new AbortController();
    const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.once("close", close); request.raw.once("aborted", close);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    try { return await jobFollow(parsed.data, controller.signal); }
    finally { reply.raw.off("close", close); request.raw.off("aborted", close); }
  });
  app.post("/v1/project/run", async (request, reply) => {
    const parsed = z.object(projectRunFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(new Error("Project caller disconnected; foreground execution cancelled")); };
    const disconnected = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", disconnected);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    try { return await projectRun(parsed.data, controller.signal); }
    catch (error) {
      if (error instanceof JobRecoveryError) return reply.code(500).send(error.toJSON());
      throw error;
    }
    finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", disconnected);
    }
  });
  app.post("/v1/project/plan", async (request, reply) => {
    const parsed = projectPlanSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return projectPlan(parsed.data);
  });
  app.get("/v1/metrics", async (request, reply) => { const p=metricsQuerySchema.safeParse(request.query); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return p.data.profile === "light" ? systemMetrics("light") : systemMetrics("full"); });
  app.get("/v1/network", async () => networkSnapshot());
  app.get("/v1/storage", async () => storageSnapshot());
  app.get("/v1/gpu", async () => gpuSnapshot());
  app.get("/v1/packages/managers", async () => packageManagers());
  app.post("/v1/packages/manage", async (request, reply) => { const p=packageSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); return packageManage(p.data); });
  app.post("/v1/wake",async(request,reply)=>{const p=wakeSchema.safeParse(request.body);if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues});const controller=new AbortController();const abort=()=>{if(!reply.raw.writableEnded)controller.abort(new Error("Wake caller disconnected"))};reply.raw.once("close",abort);request.raw.once("aborted",abort);if(request.raw.aborted||reply.raw.destroyed)abort();try{return await sendWake(p.data,controller.signal)}finally{reply.raw.off("close",abort);request.raw.off("aborted",abort)}});
  for(const route of ["/v1/power","/v1/power/request"]) app.post(route, async (request, reply) => { const p=powerSchema.safeParse(request.body); if(!p.success)return reply.code(400).send({error:"invalid_request",details:p.error.issues}); try { return await hostPower(p.data); } catch (error) {
    if (error instanceof JobRecoveryError) return reply.code(500).send(error.toJSON());
    throw error;
  } });
}
