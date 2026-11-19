import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { dispatchesFor } from "./agent-dispatch-observer.ts";
import { executionInputSchema, executionLabel, resolveExecutionContext } from "./execution-identity.ts";
import { ingressQueryFields } from "../../../packages/protocol/src/ingress-correlation.ts";

import { UsageWindows } from "./usage-windows.ts";

const windowStores = new WeakMap<AgentClient, UsageWindows>();

const agentReadTimeoutMs = 5000;
const agentSnapshotSchema = z.object({
  version: z.literal(1), instanceId: z.string().uuid(),
  totals: z.object({ received: z.number().int().nonnegative().safe() }).passthrough(),
  history: z.record(z.string(), z.unknown()),
}).passthrough();
const agentStatusSchema = z.object({
  state: z.enum(["available", "unsupported", "timeout", "error"]),
  reason: z.enum(["route_unavailable", "unsupported_contract", "identity_mismatch", "deadline_exceeded",
    "http_error", "network_error", "protocol_error", "unavailable"]).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.literal(agentReadTimeoutMs),
});
type AgentStatus = z.infer<typeof agentStatusSchema>;

function failedAgentStatus(error: unknown): AgentStatus {
  const failure = error as { kind?: unknown; name?: unknown; status?: unknown } | null;
  const httpStatus = typeof failure?.status === "number" && Number.isInteger(failure.status) &&
    failure.status >= 100 && failure.status <= 599 ? failure.status : undefined;
  if (failure?.kind === "timeout" || failure?.name === "TimeoutError")
    return { state: "timeout", reason: "deadline_exceeded", timeoutMs: agentReadTimeoutMs };
  if (httpStatus !== undefined && [404, 405, 501].includes(httpStatus))
    return { state: "unsupported", reason: "route_unavailable", httpStatus, timeoutMs: agentReadTimeoutMs };
  // Fixed categories preserve diagnostic coverage without copying error bodies,
  // endpoint URLs, credentials or arbitrary producer messages into telemetry.
  return { state: "error", reason: httpStatus !== undefined ? "http_error" :
    failure?.kind === "network" ? "network_error" : failure?.kind === "protocol" ? "protocol_error" : "unavailable",
    ...(httpStatus === undefined ? {} : { httpStatus }), timeoutMs: agentReadTimeoutMs };
}

export function registerUsageTools(server: McpServer, client: AgentClient) {
  let windows = windowStores.get(client);
  if (!windows) { windows = new UsageWindows(dispatchesFor(client)); windowStores.set(client, windows); }
  const store = windows;
  server.registerTool("usage_window", {
    description: "Read-only bounded same-agent-instance ingress measurement for ONE explicit canonical device and identity. Open, periodically collect, close, then read retained evidence. Process memory only: 8 windows, 15-minute TTL, 256 events/dispatches each. Preserves original dispatch envelopes before global ring eviction. Missing/late detail, overflow and restarts remain explicit. Shared bearer/correlation are not source attestation, authorization or effect proof. No workload execution/replay.",
    inputSchema: z.object({ device: z.string().min(1), identity: z.enum(["owner", "root", "interactive"]),
      action: z.enum(["open", "collect", "close", "read"]), windowId: z.string().uuid().optional(),
      detailOffset: z.number().int().min(0).max(256).default(0), detailLimit: z.number().int().min(0).max(16).default(0),
    }).strict(),
    outputSchema: z.object({ report: z.record(z.string(), z.unknown()), agentStatus: agentStatusSchema.nullable() }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ device, identity, action, windowId, detailOffset, detailLimit }, extra) => {
    if (client.getDevice(device).name !== device) throw new Error("usage_window_requires_canonical_device");
    const target = resolveExecutionContext(client, device, { identity }, "system");
    if ((action === "open") === Boolean(windowId)) throw new Error("usage_window_invalid_id");
    const w = action === "open" ? store.open(device, identity) : store.get(windowId!, device, identity);
    if (w.busy) throw new Error("usage_window_busy");
    let agentStatus: AgentStatus | null = null;
    if (action !== "read" && w.state !== "closed" && w.state !== "restart") {
      w.busy = true;
      try {
        // A close drains bounded, cursor-based pages before freezing the end.
        // All pages share one five-second budget; incomplete closes stay active.
        const deadline = Date.now() + agentReadTimeoutMs;
        for (let page = 0; page < (action === "close" ? 10 : 1); page++) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            agentStatus = { state: "timeout", reason: "deadline_exceeded", timeoutMs: agentReadTimeoutMs };
            break;
          }
          const raw = await client.requestRoute(device, "/v1/observations/ingress",
            { sampleLimit: 32, seriesLimit: 0, historyLimit: 0, ...(w.start ? { sampleAfterSequence: w.sampleAfterSequence } : {}) }, target,
            { timeoutMs: Math.min(agentReadTimeoutMs, remaining), signal: extra.signal, observeOperation: false });
          if (!store.ingest(w, raw, false)) {
            w.failedReads++;
            const reason = w.lastReadFailure ?? "unsupported_contract";
            agentStatus = { state: reason === "identity_mismatch" ? "error" : "unsupported", reason, timeoutMs: agentReadTimeoutMs };
            break;
          }
          agentStatus = { state: "available", timeoutMs: agentReadTimeoutMs };
          if (action !== "close" || w.state !== "active" || store.finishClose(w)) break;
        }
        if (action === "close" && w.state === "active" && agentStatus?.state === "available") w.closeDeferred = true;
      } catch (error) {
        if (extra.signal.aborted) { if (action === "open") store.discard(w); extra.signal.throwIfAborted(); }
        w.failedReads++; agentStatus = failedAgentStatus(error);
      } finally { w.busy = false; }
    }
    store.get(w.id, device, identity); // A read deadline must not extend retention.
    const value = { report: store.report(w, detailOffset, detailLimit), agentStatus };
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  });
  server.registerTool("usage_report", {
    description: "Read bounded agent ingress counters, UTC daily history and optional trace/route pages for one execution identity. Retains controller dispatch data when agent ingress is unsupported, unavailable or times out; agentStatus states that limit explicitly. Includes direct and controller traffic; separates authenticated bearer possession from caller-declared correlation. Counts requests, not completed tasks or verified effects. History starts at collection and cannot reconstruct older weeks. Agent detail requires agent-ingress-v1; no workload execution or replay.",
    inputSchema: executionInputSchema({ device: z.string().min(1), ...ingressQueryFields }),
    outputSchema: z.object({
      version: z.literal(1), device: z.string(), identity: z.enum(["root", "owner", "interactive"]),
      agent: z.record(z.string(), z.unknown()).nullable(), agentStatus: agentStatusSchema,
      controller: z.record(z.string(), z.unknown()),
      comparison: z.object({ automaticSameWindowReconciliation: z.literal(false), reason: z.string() }),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ device, context, identity, elevation, ...query }, extra) => {
    const target = resolveExecutionContext(client, device, { context, identity, elevation }, "system");
    const canonical = client.getDevice(device).name;
    const selected = executionLabel(target);
    let agent: Record<string, unknown> | null = null;
    let agentStatus: AgentStatus;
    try {
      // The endpoint's versioned contract avoids a second capability probe on
      // the healthy path and keeps this diagnostic to one agent dispatch.
      const response = await client.requestRoute<Record<string, unknown>>(canonical, "/v1/observations/ingress", query, target,
        { timeoutMs: agentReadTimeoutMs, signal: extra.signal, observeOperation: false });
      const parsed = agentSnapshotSchema.safeParse(response);
      if (parsed.success) {
        agent = parsed.data;
        agentStatus = { state: "available", timeoutMs: agentReadTimeoutMs };
      } else {
        agentStatus = { state: "unsupported", reason: "unsupported_contract", timeoutMs: agentReadTimeoutMs };
      }
    } catch (error) {
      // Caller cancellation still ends the tool. A failed producer read leaves
      // its attempted dispatch and earlier controller observations available.
      extra.signal.throwIfAborted();
      agentStatus = failedAgentStatus(error);
    }
    const controller = dispatchesFor(client).snapshot(canonical, selected, { sampleOffset: query.sampleOffset, sampleLimit: query.sampleLimit ?? 16 });
    const value = {
      version: 1 as const, device: canonical, identity: selected, agent, agentStatus, controller,
      comparison: {
        automaticSameWindowReconciliation: false as const,
        reason: agent
          ? "Agent and controller lifetimes and capture instants differ. Compare stable receipts or explicitly bracket a same-instance window; unmatched traffic remains unassigned. Current snapshots include this diagnostic request."
          : "Agent ingress is unavailable for this read. Controller dispatch observations remain available; agent totals and same-window coverage are not inferred.",
      },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  });
}
