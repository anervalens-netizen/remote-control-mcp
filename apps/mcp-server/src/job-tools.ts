import { toolErrorDetails, withToolErrors } from "./tool-errors.ts";
import { jobFollowFields, jobLineageFields } from "../../../packages/protocol/src/project.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient, AgentContext, AgentEndpointContext } from "./agent-client.ts";
import { mapLimit } from "./concurrency.ts";
import { elevationSchema, executionInputSchema, executionLabel, identitySchema, legacyContextSchema, resolveExecutionContext } from "./execution-identity.ts";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const routedText = (legacyValue: unknown, context: AgentEndpointContext, structuredValue?: Record<string, unknown>) => ({
  ...text(legacyValue),
  structuredContent: structuredValue ?? (Array.isArray(legacyValue)
    ? { items: legacyValue, identity: executionLabel(context), context }
    : { ...(legacyValue as Record<string, unknown>), identity: executionLabel(context), context }),
});

export async function startJobsMany(client: AgentClient, devices: string[], input: { command: string; cwd?: string; env?: Record<string, string>; idempotencyKey?: string }, context: AgentContext | AgentEndpointContext = "system", concurrency?: number) {
  return mapLimit(devices, concurrency, async (device) => {
    try { return { device, context, ok: true as const, job: await client.jobStart(device, input, context) }; }
    catch (error) { return { device, context, ok: false as const, ...toolErrorDetails(error) }; }
  });
}

export function registerJobTools(server: McpServer, client: AgentClient): void {
  const startSchema = executionInputSchema({ device: z.string().min(1), command: z.string().min(1), idempotencyKey: z.string().min(1).max(200).optional(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional() });
  server.registerTool("job_start", { description: "Start a durable background job. Optional idempotencyKey prevents repeated starts for identical input; uncertain prior starts are never replayed automatically.", inputSchema: startSchema },
    async ({ device, context, identity, elevation, ...input }) => withToolErrors(async () => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      const result = await client.jobStart(device, input, target);
      return routedText(result, target);
    }));
  server.registerTool("job_start_many", { description: "Start the same durable background job on multiple devices with bounded parallelism and return per-device success/error results.", inputSchema: executionInputSchema({ devices: z.array(z.string().min(1)).min(1), command: z.string().min(1), idempotencyKey: z.string().min(1).max(200).optional(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), concurrency: z.number().int().min(1).max(32).optional() }) },
    async ({ devices, context, identity, elevation, concurrency, ...input }) => {
      // Resolve every target before dispatch so an unavailable device/context
      // cannot leave a partially effected batch behind.
      const planned = devices.map((device) => ({ device, target: resolveExecutionContext(client, device, { context, identity, elevation }, "system") }));
      const target = planned[0]?.target ?? "system";
      const results = await startJobsMany(client, devices, input, target, concurrency);
      const routed = results.map((result) => ({ ...result, identity: executionLabel(target), context: target }));
      return routedText(results, target, { items: routed, identity: executionLabel(target), context: target });
    });
  server.registerTool("job_lineage", { description: "Page the full durable identity-bound process ledger (up to 256 identities per page). Historical evidence, not a live process list; native identity strings are opaque. Status/wait/list only return trackedProcessCount.", inputSchema: executionInputSchema({ device: z.string().min(1), ...jobLineageFields }) },
    async ({ device, context, identity, elevation, ...input }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.requestRoute(device, "/v1/jobs/lineage", input, target), target);
    });
  server.registerTool("job_status", { description: "Get durable job status and output sizes.", inputSchema: executionInputSchema({ device: z.string().min(1), id: z.string().min(1) }) },
    async ({ device, id, context, identity, elevation }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.jobStatus(device, id, target), target);
    });
  server.registerTool("job_output", { description: "Read a bounded byte range from a durable job stdout or stderr; negative offsets tail from the end.", inputSchema: executionInputSchema({ device: z.string().min(1), id: z.string().min(1), stream: z.enum(["stdout", "stderr"]).optional(), offset: z.number().int().optional(), length: z.number().int().positive().max(1024 * 1024).optional(), encoding: z.enum(["utf8", "base64"]).optional() }) },
    async ({ device, context, identity, elevation, ...input }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.jobOutput(device, input, target), target);
    });
  server.registerTool("job_wait", {
    description: "Wait for a durable job to finish (default) or produce output (until=output). Returns status/progress, both streams and a resumable byte cursor. Default wait 30s; timeout/cancellation stops waiting, not the job. Repeat with cursor until outputComplete=true.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...jobFollowFields }),
  }, async ({ device, context, identity, elevation, ...input }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return routedText(await client.jobFollow(device, input, target, extra.signal), target);
  });
  server.registerTool("job_output_since", {
    description: "Read both durable job streams since the previous cursor with current status/progress in one call. UTF-8 boundaries are preserved; pages can exceed maxBytes by up to 3 bytes for one code point. Base64 preserves arbitrary bytes. Repeat until outputComplete=true.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...jobFollowFields }),
  }, async ({ device, context, identity, elevation, ...input }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    return routedText(await client.jobFollow(device, { ...input, waitMs: input.waitMs ?? 0, until: "output" }, target, extra.signal), target);
  });
  server.registerTool("job_cancel", { description: "Cancel a durable job and its process tree.", inputSchema: executionInputSchema({ device: z.string().min(1), id: z.string().min(1) }) },
    async ({ device, id, context, identity, elevation }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.jobCancel(device, id, target), target);
    });
  server.registerTool("job_list", { description: "List recent durable jobs on a device.", inputSchema: executionInputSchema({ device: z.string().min(1), limit: z.number().int().positive().max(1000).optional() }) },
    async ({ device, limit, context, identity, elevation }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.jobs(device, limit, target), target);
    });
  server.registerTool("job_remove", { description: "Remove durable job metadata and output files; force can cancel a running job first.", inputSchema: executionInputSchema({ device: z.string().min(1), id: z.string().min(1), force: z.boolean().optional() }) },
    async ({ device, id, force, context, identity, elevation }) => {
      const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
      return routedText(await client.jobRemove(device, { id, force }, target), target);
    });
}
