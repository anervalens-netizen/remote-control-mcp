import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { AgentClient } from "./agent-client.ts";
import { fleetSnapshot } from "./fleet-snapshot.ts";
import { jobReferenceSchema, operationsFor } from "./operation-observer.ts";
import { utf8Preview } from "./result-text.ts";
import { CONSOLE_URI, consoleIcon } from "./console-resource.ts";

const json = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
const scope = z.string().uuid().optional();
const reference = z.object({ traceId: z.string().uuid().optional(), job: jobReferenceSchema.optional() }).strict()
  .refine(input => Boolean(input.traceId) !== Boolean(input.job), "Provide exactly one traceId or job reference");
const snapshotInput = {
  diagnosticScopeId: scope, includeFleet: z.boolean().optional(), fleetCursor: z.string().max(4096).optional(), cursor: z.string().max(4096).optional(),
  jobDevice: z.string().max(256).optional(), jobIdentity: z.enum(["owner", "root", "interactive"]).optional(), jobCursor: z.string().max(4096).optional(),
};
const record = z.record(z.string(), z.unknown());
const snapshotSchema = z.object({ observedAt: z.string(), diagnosticScopeId: scope, operations: record, fleet: record.nullable(), jobs: record.nullable() });
const pendingFleet = new WeakMap<AgentClient, Map<string, Promise<Record<string, unknown>>>>();
async function sharedFleet(client: AgentClient, cursor?: string) {
  let pages = pendingFleet.get(client);
  if (!pages) { pages = new Map(); pendingFleet.set(client, pages); }
  const key = cursor ?? "";
  let pending = pages.get(key);
  if (!pending) {
    pending = (async () => {
      const names = client.devices.map(device => device.name).sort();
      const remaining = cursor ? names.filter(name => name > cursor) : names;
      const selected = remaining.slice(0, 10);
      const result = selected.length ? await fleetSnapshot(client, { devices: selected, identity: "auto", concurrency: 4 }) : { devices: [] };
      const devices = result.devices.map(raw => {
        const row = raw as Record<string, any>;
        // UI observations use a deliberate summary, never unbounded host data.
        const summary: Record<string, unknown> = { device: row.device };
        for (const field of ["identity", "connectivity", "readiness", "observedAt", "expectedAvailability", "platform", "metricsStatus", "reason"]) {
          const value = row[field];
          if (typeof value === "string") summary[field] = utf8Preview(value, field === "reason" ? 512 : 128);
          else if (value === null) summary[field] = null;
        }
        summary.configuredIdentities = Array.isArray(row.configuredIdentities) ? row.configuredIdentities.slice(0, 3) : [];
        if (typeof row.runtime?.sha === "string") summary.runtime = { sha: row.runtime.sha.slice(0, 128) };
        for (const field of ["endpointResponded", "agentResponseValid", "identityConfigured", "memoryUsedPercent", "rootUsedPercent"]) {
          if (typeof row[field] === "boolean" || typeof row[field] === "number" || row[field] === null) summary[field] = row[field];
        }
        return summary;
      });
      let bytes = 0;
      const bounded: typeof devices = [];
      for (const row of devices) {
        const size = Buffer.byteLength(JSON.stringify(row));
        if (bytes + size > 16 * 1024) break;
        bytes += size; bounded.push(row);
      }
      // Inventory names must remain exact; never silently shorten routing IDs.
      if (devices.length && !bounded.length) throw new Error("Device metadata exceeds the console page limit");
      const last = bounded.at(-1)?.device as string | undefined;
      return { devices: bounded, totalConfigured: names.length, nextCursor: last && names.some(name => name > last) ? last : null,
        scope: "Selected inventory page; missing or stale observations do not establish device state." };
    })();
    pages.set(key, pending);
    const active = pending;
    void pending.finally(() => { if (pages!.get(key) === active) pages!.delete(key); }).catch(() => {});
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
    input.includeFleet === false ? null : sharedFleet(client, input.fleetCursor),
    input.jobDevice ? (async () => {
      if (!input.jobIdentity) throw new Error("jobIdentity is required with jobDevice");
      const device = client.getDevice(input.jobDevice!).name;
      try {
        const params = new URLSearchParams({ limit: "10" }); if (input.jobCursor) params.set("cursor", input.jobCursor);
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
    inputSchema: { reference, detailOffset: z.number().int().nonnegative().optional(), output: z.object({ stream: z.enum(["stdout", "stderr"]), offset: z.number().int().optional(), length: z.number().int().min(1).max(8192).optional() }).strict().optional() },
    outputSchema: z.object({ observedAt: z.string(), reference, observation: record.nullable(), output: record.nullable(), coverage: z.string() }), annotations: readOnly,
    _meta: { ui: { visibility: ["app"] } },
  }, async (input, extra) => {
    if (input.reference.traceId) {
      if (input.output) throw new Error("Select a job reference before reading output");
      const raw = await operationsFor(client).inspect(input.reference.traceId);
      const offset = input.detailOffset ?? 0;
      const observation = raw ? { ...raw, events: raw.events.slice(offset, offset + 8), jobs: raw.jobs.slice(offset, offset + 8),
        terminalJobs: raw.terminalJobs?.slice(offset, offset + 8),
        eventCount: raw.events.length, jobCount: raw.jobs.length, detailOffset: offset,
        nextDetailOffset: Math.max(raw.events.length, raw.jobs.length, raw.terminalJobs?.length ?? 0) > offset + 8 ? offset + 8 : null } : null;
      return json({ observedAt: new Date().toISOString(), reference: input.reference, observation, output: null,
        coverage: "Controller observation page only; handler return is not client acceptance or job completion. Missing metadata does not authorize replay." });
    }
    const job = input.reference.job!;
    const device = client.getDevice(job.device).name;
    const selected = { device, identity: job.identity, jobId: job.jobId };
    const status = await client.jobStatus(device, job.jobId, context(job.identity), { timeoutMs: 3000, signal: extra.signal });
    await operationsFor(client).reconcileJob(selected, (status as Record<string, unknown>).state);
    const output = input.output ? await client.requestRoute<Record<string, unknown>>(device, "/v1/jobs/output", { id: job.jobId, ...input.output, length: input.output.length ?? 4096, encoding: "utf8" }, context(job.identity), { timeoutMs: 3000, signal: extra.signal }) : null;
    return json({ observedAt: new Date().toISOString(), reference: { job: selected }, observation: jobSummary(status), output,
      coverage: "Fresh agent observation. Job exit is separate from effect verification and client acceptance." });
  });
}
