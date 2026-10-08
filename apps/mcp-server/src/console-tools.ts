import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { AgentClient } from "./agent-client.ts";
import { fleetSnapshot } from "./fleet-snapshot.ts";
import { jobReferenceSchema, operationsFor } from "./operation-observer.ts";
import { CONSOLE_URI, consoleIcon } from "./console-resource.ts";

const json = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
const scope = z.string().uuid().optional();
const reference = z.object({ traceId: z.string().uuid().optional(), job: jobReferenceSchema.optional() }).strict()
  .refine(input => Boolean(input.traceId) !== Boolean(input.job), "Provide exactly one traceId or job reference");
const snapshotInput = {
  diagnosticScopeId: scope, includeFleet: z.boolean().optional(), cursor: z.string().max(4096).optional(),
  jobDevice: z.string().max(256).optional(), jobIdentity: z.enum(["owner", "root", "interactive"]).optional(), jobCursor: z.string().max(4096).optional(),
};
const record = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({ observedAt: z.string(), diagnosticScopeId: scope, operations: record, fleet: record.nullable(), jobs: record.nullable() });
const pendingFleet = new WeakMap<AgentClient, Promise<Awaited<ReturnType<typeof fleetSnapshot>>>>();
async function sharedFleet(client: AgentClient) {
  let pending = pendingFleet.get(client);
  if (!pending) {
    pending = fleetSnapshot(client, { identity: "auto", concurrency: 4 });
    pendingFleet.set(client, pending);
    void pending.finally(() => { if (pendingFleet.get(client) === pending) pendingFleet.delete(client); }).catch(() => {});
  }
  return pending;
}
const context = (identity: "root" | "owner" | "interactive") => identity === "root" ? "system" : identity === "owner" ? "user" : "desktop";
function jobSummary(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return { state: "unknown" };
  const value = input as Record<string, unknown>;
  return Object.fromEntries(["id", "state", "code", "exitCode", "signal", "pid", "startedAt", "finishedAt", "stdoutBytes", "stderrBytes", "trackedProcessCount", "terminationVerified", "terminationVerificationScope"]
    .filter(key => typeof value[key] === "string" || typeof value[key] === "number" || typeof value[key] === "boolean" || value[key] === null)
    .map(key => [key, value[key]]));
}
async function snapshot(client: AgentClient, input: z.infer<z.ZodObject<typeof snapshotInput>>, signal?: AbortSignal) {
  const [operations, fleet, jobs] = await Promise.all([
    operationsFor(client).snapshot(input),
    input.includeFleet === false ? null : sharedFleet(client),
    input.jobDevice ? (async () => {
      if (!input.jobIdentity) throw new Error("jobIdentity is required with jobDevice");
      const device = client.getDevice(input.jobDevice!).name;
      try {
        const params = new URLSearchParams({ limit: "20" }); if (input.jobCursor) params.set("cursor", input.jobCursor);
        const history = await client.requestRoute<Record<string, unknown>>(device, `/v1/jobs/history?${params}`, undefined, context(input.jobIdentity), { timeoutMs: 3000, signal });
        return { device, identity: input.jobIdentity, observedAt: new Date().toISOString(), items: Array.isArray(history.items) ? history.items.map(jobSummary) : [], nextCursor: history.nextCursor ?? null,
          partial: history.partial === true || !Array.isArray(history.items), freshness: history.freshness ?? null };
      } catch { return { device, identity: input.jobIdentity, observedAt: new Date().toISOString(), items: [], partial: true, error: "Job history unavailable; absence is not proof of no jobs." }; }
    })() : null,
  ]);
  return { observedAt: new Date().toISOString(), ...(input.diagnosticScopeId ? { diagnosticScopeId: input.diagnosticScopeId } : {}), operations, fleet, jobs };
}

export function registerConsoleTools(server: McpServer, client: AgentClient) {
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  registerAppTool(server, "open_remote_control_console", {
    title: "Remote Control Console", description: "Open the read-only fleet and operation console. Scope is client-declared, not proof of chat history. Existing operation/job references can be selected without reassignment.",
    inputSchema: { diagnosticScopeId: scope, reference: reference.optional() },
    outputSchema: snapshotSchema.extend({ selected: reference.optional() }), annotations: readOnly,
    _meta: { ui: { resourceUri: CONSOLE_URI, visibility: ["model", "app"] }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }], preferredModelDisplayMode: "fullscreen" } satisfies OpenAIUiToolMetadata },
  }, async input => {
    let diagnosticScopeId = input.diagnosticScopeId;
    if (!diagnosticScopeId && input.reference?.traceId) diagnosticScopeId = (await operationsFor(client).inspect(input.reference.traceId))?.diagnosticScopeId;
    diagnosticScopeId ??= randomUUID();
    return json({ ...await snapshot(client, { diagnosticScopeId }), ...(input.reference ? { selected: input.reference } : {}) });
  });
  registerAppTool(server, "dashboard_snapshot", {
    description: "Read bounded fleet and associated operation metadata; optional selected-device job history. No raw logs or commands.",
    inputSchema: snapshotInput, outputSchema: snapshotSchema, annotations: readOnly, _meta: { ui: { visibility: ["app"] } },
  }, async (input, extra) => json(await snapshot(client, input, extra.signal)));
  registerAppTool(server, "operation_inspect", {
    description: "Inspect one observed trace or a durable job reference. Output is read only on explicit bounded page request; never replays execution.",
    inputSchema: { reference, output: z.object({ stream: z.enum(["stdout", "stderr"]), offset: z.number().int().optional(), length: z.number().int().min(1).max(8192).optional() }).strict().optional() },
    outputSchema: z.object({ observedAt: z.string(), reference, observation: record.nullable(), output: record.nullable(), coverage: z.string() }), annotations: readOnly,
    _meta: { ui: { visibility: ["app"] } },
  }, async (input, extra) => {
    if (input.reference.traceId) {
      if (input.output) throw new Error("Select a job reference before reading output");
      return json({ observedAt: new Date().toISOString(), reference: input.reference, observation: await operationsFor(client).inspect(input.reference.traceId), output: null,
        coverage: "Controller observation only; handler return is not client acceptance or job completion. Missing metadata does not authorize replay." });
    }
    const job = input.reference.job!;
    const device = client.getDevice(job.device).name;
    const selected = { device, identity: job.identity, jobId: job.jobId };
    const status = await client.jobStatus(device, job.jobId, context(job.identity), { timeoutMs: 3000, signal: extra.signal });
    const output = input.output ? await client.requestRoute<Record<string, unknown>>(device, "/v1/jobs/output", { id: job.jobId, ...input.output, length: input.output.length ?? 4096, encoding: "utf8" }, context(job.identity), { timeoutMs: 3000, signal: extra.signal }) : null;
    return json({ observedAt: new Date().toISOString(), reference: { job: selected }, observation: jobSummary(status), output,
      coverage: "Fresh agent observation. Job exit is separate from effect verification and client acceptance." });
  });
}
