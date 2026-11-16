import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { operationsFor } from "../apps/mcp-server/src/operation-observer.ts";
import { repoRecoveryReceipt } from "../apps/mcp-server/src/repo-recovery-receipt.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (closers.length) await closers.pop()!(); vi.unstubAllEnvs(); });

function receipt(operation: "fetch" | "pull" | "push") {
  const jobId = randomUUID(), operationId = randomUUID(), at = new Date().toISOString();
  const token = { resourceId: "a".repeat(64), operationId, generation: 1, baseVersion: "b".repeat(64) };
  return {
    operation, recoveryMode: "durable_job" as const, noReplay: true as const, effectVerification: "unverified" as const, jobId,
    coordination: { ...token, version: 1 as const, budgetSlot: 0, device: "c".repeat(64), identity: "d".repeat(64), canonicalKey: "e".repeat(64),
      state: "active" as const, createdAt: at, updatedAt: at, expiresAt: Date.now() + 30_000, instanceId: randomUUID(), jobId, conflictReason: null, overrides: [], token },
    recovery: { execution: { kind: "repo_job" as const, key: `coordination-repo:${operationId}`, fingerprint: "f".repeat(64), requestHash: "0".repeat(64) }, resolution: null },
  };
}

async function connect(operation: "fetch" | "pull" | "push", status: number, body: Record<string, unknown>, jobExitCode = status === 500 ? 1 : 0) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rcmcp-repo-sdk-")); closers.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("RCMCP_STATE_DIR", directory);
  const app = Fastify(); let repositoryDispatches = 0, statusReads = 0;
  app.get("/v1/info", async () => ({ runtime: { capabilities: ["high-level-coordination-v1", "coordination-recovery-v1"] } }));
  app.post(`/v1/repo/${operation}`, async (_request, reply) => { repositoryDispatches++; return reply.code(status).send(body); });
  app.post("/v1/jobs/status", async request => { statusReads++; return { id: (request.body as any).id, state: "completed", exitCode: jobExitCode }; });
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const agent = new AgentClient([{ name: "lab", aliases: ["alias"], url, userUrl: url }]);
  const server = new McpServer({ name: "repository-recovery", version: "1" }); registerTools(server, agent);
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  await client.listTools(); // Exercise the SDK's advertised output-schema validation.
  return { client, agent, counters: () => ({ repositoryDispatches, statusReads }), call: () => client.callTool({
    name: `repo_${operation}`, arguments: { device: "alias", identity: "owner", path: "/synthetic/repository" },
  }) };
}

it.each(["fetch", "pull", "push"] as const)("delivers %s pending receipts and pins the original job without claiming process success", async operation => {
  const metadata = receipt(operation);
  const pending = { ...metadata, ok: false, accepted: true, executionPending: true, job: { id: metadata.jobId, state: "running" }, nextAction: "Inspect the original job and reconcile its token; do not replay." };
  const { call, client, agent, counters } = await connect(operation, 202, pending);
  const result = await call();
  expect(result.isError).not.toBe(true);
  const delivered = result.structuredContent as any;
  expect(delivered).toMatchObject({ identity: "owner", context: "user", result: pending });
  expect(delivered.result).not.toHaveProperty("executionOutcome");
  expect(delivered.result).not.toHaveProperty("operationSucceeded");
  const observer = operationsFor(agent), traceId = delivered.operationTrace.traceId;
  expect(await observer.inspect(traceId)).toMatchObject({ state: "returned", requestSucceeded: true, jobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86400_000);
  await observer.begin("device_info", undefined);
  expect(await observer.inspect(traceId)).not.toBeNull();
  vi.restoreAllMocks();
  const status = await client.callTool({ name: "job_status", arguments: { device: "alias", identity: "owner", id: metadata.jobId } });
  expect(status.isError).not.toBe(true);
  expect(await observer.inspect(traceId)).toMatchObject({ terminalJobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect(counters()).toEqual({ repositoryDispatches: 1, statusReads: 1 });
});

it.each(["top_level", "coordination_only"] as const)("preserves bounded failure recovery metadata and the %s locator through a real MCP error", async placement => {
  const metadata = receipt("push");
  const body: Record<string, unknown> = { ...metadata, ok: false, error: "repository_operation_failed", message: "Synthetic partial operation failure",
    operationSucceeded: false, executionOutcome: "exit_nonzero", resultPublication: placement === "top_level" ? "available" : "unavailable",
    rawArguments: { path: "private-path-marker", password: "private-secret-marker" }, rawOutput: "private-output-marker" };
  if (placement === "coordination_only") delete body.jobId;
  const { call, client, agent, counters } = await connect("push", 500, body);
  const result = await call();
  expect(result.isError).toBe(true);
  const delivered = result.structuredContent as any;
  expect(delivered).toMatchObject({ ok: false, requestSucceeded: false, status: 500, noReplay: true, jobId: metadata.jobId,
    coordination: { token: metadata.coordination.token }, recovery: metadata.recovery, operationSucceeded: false, executionOutcome: "exit_nonzero", effectVerification: "unverified",
    resultPublication: placement === "top_level" ? "available" : "unavailable" });
  expect(JSON.stringify(delivered)).not.toMatch(/private-path-marker|private-secret-marker|private-output-marker|rawArguments|rawOutput/);
  const observer = operationsFor(agent), traceId = delivered.operationTrace.traceId;
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false, jobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 86400_000);
  await observer.begin("device_info", undefined);
  expect(await observer.inspect(traceId)).not.toBeNull();
  vi.restoreAllMocks();
  await client.callTool({ name: "job_status", arguments: { device: "alias", identity: "owner", id: delivered.jobId } });
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false, terminalJobs: [{ jobId: metadata.jobId }] });
  expect(counters()).toEqual({ repositoryDispatches: 1, statusReads: 1 });
});

it("preserves successful execution evidence in an HTTP 500 recovery receipt without treating the response as terminal authority", async () => {
  const metadata = receipt("pull");
  const body = { ...metadata, ok: false, error: "repository_execution_requires_recovery", operationSucceeded: true,
    executionOutcome: "exit_zero", resultPublication: "available", rawArguments: "private-original-arguments" };
  const { call, client, agent, counters } = await connect("pull", 500, body, 0);
  const result = await call(), delivered = result.structuredContent as any;
  expect(result.isError).toBe(true);
  expect(delivered).toMatchObject({ ok: false, requestSucceeded: false, status: 500, noReplay: true, jobId: metadata.jobId,
    coordination: { token: metadata.coordination.token }, recovery: metadata.recovery, operationSucceeded: true,
    executionOutcome: "exit_zero", resultPublication: "available", effectVerification: "unverified" });
  expect(JSON.stringify(delivered)).not.toContain("private-original-arguments");
  const observer = operationsFor(agent), traceId = delivered.operationTrace.traceId;
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false,
    jobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  const recovered = await client.callTool({ name: "result_recover", arguments: { id: delivered.resultRecovery.id } });
  expect(recovered.isError).not.toBe(true);
  const page = recovered.structuredContent as any;
  expect(page.eof).toBe(true);
  const original = JSON.parse(Buffer.from(page.data, "base64").toString("utf8"));
  expect(original.isError).toBe(true);
  expect(original.structuredContent).toMatchObject({ operationTrace: delivered.operationTrace, noReplay: true,
    jobId: metadata.jobId, coordination: { token: metadata.coordination.token }, recovery: metadata.recovery,
    operationSucceeded: true, executionOutcome: "exit_zero", resultPublication: "available" });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  const status = await client.callTool({ name: "job_status", arguments: { device: "alias", identity: "owner", id: delivered.jobId } });
  expect(status.isError).not.toBe(true);
  expect(status.structuredContent).toMatchObject({ id: metadata.jobId, state: "completed", exitCode: 0 });
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false,
    terminalJobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect(counters()).toEqual({ repositoryDispatches: 1, statusReads: 1 });
});

it("preserves the original recovery receipt through an HTTP 409 coordination conflict without replay or terminal authority", async () => {
  const metadata = receipt("pull");
  const { token: _token, ...record } = metadata.coordination;
  const details = { reason: "capacity_index_unreadable", coordination: record };
  const body = { ...metadata, ok: false, error: "coordination_conflict", code: "COORDINATION_CONFLICT", details,
    operationSucceeded: true, executionOutcome: "exit_zero", resultPublication: "available", rawArguments: "private-conflict-arguments" };
  const { call, client, agent, counters } = await connect("pull", 409, body, 0);
  const result = await call(), delivered = result.structuredContent as any;
  expect(result.isError).toBe(true);
  expect(delivered).toMatchObject({ ok: false, requestSucceeded: false, kind: "http", status: 409, agentCode: "COORDINATION_CONFLICT",
    noReplay: true, jobId: metadata.jobId, coordination: metadata.coordination, recovery: metadata.recovery,
    operationSucceeded: true, executionOutcome: "exit_zero", resultPublication: "available", effectVerification: "unverified" });
  expect(delivered.coordinationConflict).toEqual(details);
  expect(delivered.coordinationConflict.coordination).not.toHaveProperty("token");
  expect(JSON.stringify(delivered)).not.toContain("private-conflict-arguments");
  const observer = operationsFor(agent), traceId = delivered.operationTrace.traceId;
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false,
    jobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  const recovered = await client.callTool({ name: "result_recover", arguments: { id: delivered.resultRecovery.id } });
  expect(recovered.isError).not.toBe(true);
  const page = recovered.structuredContent as any;
  expect(page.eof).toBe(true);
  const original = JSON.parse(Buffer.from(page.data, "base64").toString("utf8"));
  expect(original.isError).toBe(true);
  expect(original.structuredContent).toMatchObject({ operationTrace: delivered.operationTrace, status: 409,
    coordinationConflict: details, noReplay: true, jobId: metadata.jobId, coordination: metadata.coordination,
    recovery: metadata.recovery, operationSucceeded: true, executionOutcome: "exit_zero", resultPublication: "available" });
  expect((await observer.inspect(traceId))?.terminalJobs).toBeUndefined();
  const status = await client.callTool({ name: "job_status", arguments: { device: "alias", identity: "owner", id: delivered.jobId } });
  expect(status.isError).not.toBe(true);
  expect(status.structuredContent).toMatchObject({ id: metadata.jobId, state: "completed", exitCode: 0 });
  expect(await observer.inspect(traceId)).toMatchObject({ state: "unknown", requestSucceeded: false,
    terminalJobs: [{ device: "lab", identity: "owner", jobId: metadata.jobId }] });
  expect(counters()).toEqual({ repositoryDispatches: 1, statusReads: 1 });
});

it("keeps binding-only failures recoverable without inventing a job locator", async () => {
  const metadata = receipt("fetch");
  const { jobId: _jobId, ...withoutTopJob } = metadata;
  const { jobId: _recordJob, ...coordination } = metadata.coordination;
  const { call, agent } = await connect("fetch", 500, { ...withoutTopJob, coordination, error: "repository_operation_failed" });
  const result = await call(), delivered = result.structuredContent as any;
  expect(result.isError).toBe(true);
  expect(delivered).toMatchObject({ noReplay: true, coordination: { token: metadata.coordination.token }, recovery: metadata.recovery });
  expect(delivered).not.toHaveProperty("jobId");
  expect(await operationsFor(agent).inspect(delivered.operationTrace.traceId)).toMatchObject({ state: "unknown", jobs: [] });
});

it("preserves explicit legacy limits and the original token without inventing durable job authority", async () => {
  const metadata = receipt("pull");
  const { jobId: _recordJob, ...coordination } = metadata.coordination;
  const body = { error: "repository_operation_failed", recoveryMode: "legacy", containment: "unverified", recoveryLimitation: "unsupported_platform",
    noReplay: true, effectVerification: "unverified", coordination, rawArguments: "private-legacy-args" };
  const { call, agent } = await connect("pull", 500, body);
  const result = await call(), delivered = result.structuredContent as any;
  expect(result.isError).toBe(true);
  expect(delivered).toMatchObject({ ok: false, requestSucceeded: false, noReplay: true, recoveryMode: "legacy", containment: "unverified",
    recoveryLimitation: "unsupported_platform", coordination: { token: metadata.coordination.token } });
  expect(delivered).not.toHaveProperty("jobId");
  expect(delivered).not.toHaveProperty("executionOutcome");
  expect(JSON.stringify(delivered)).not.toContain("private-legacy-args");
  expect(await operationsFor(agent).inspect(delivered.operationTrace.traceId)).toMatchObject({ state: "unknown", jobs: [] });
  expect(repoRecoveryReceipt("/v1/repo/pull", { ...body, jobId: randomUUID() })).toBeUndefined();
});

it("rejects mismatched locators and tokens and never forwards unrelated payload fields", () => {
  const metadata = receipt("fetch");
  expect(repoRecoveryReceipt("/v1/fs/read", metadata)).toBeUndefined();
  expect(repoRecoveryReceipt("/v1/repo/push", metadata)).toBeUndefined();
  expect(repoRecoveryReceipt("/v1/repo/fetch", { ...metadata, jobId: randomUUID() })).toBeUndefined();
  expect(repoRecoveryReceipt("/v1/repo/fetch", { ...metadata, coordination: { ...metadata.coordination, token: { ...metadata.coordination.token, generation: 2 } } })).toBeUndefined();
  expect(repoRecoveryReceipt("/v1/repo/fetch", { ...metadata, recovery: { ...metadata.recovery, execution: { ...metadata.recovery.execution, key: "private-unrelated-key" } } })).toBeUndefined();
  expect(repoRecoveryReceipt("/v1/repo/fetch", { ...metadata, rawArguments: "private" })).not.toHaveProperty("rawArguments");
});

it.each(["missing_success_fields", "pending_claims_process_success"] as const)("does not weaken the success contract for %s", async kind => {
  const metadata = receipt("fetch");
  const body = kind === "missing_success_fields" ? { ok: true, operation: "fetch", remote: "origin" }
    : { ...metadata, ok: false, accepted: true, executionPending: true, job: { id: metadata.jobId, state: "running" }, nextAction: "Inspect the original job", executionOutcome: "exit_zero" };
  const { call } = await connect("fetch", 202, body);
  const result = await call();
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ ok: false, code: "result_validation_failed" });
});
