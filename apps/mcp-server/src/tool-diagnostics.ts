import { resultMetadataFields } from "./result-recovery.ts";
import type { Trace } from "../../../packages/protocol/src/diagnostic-context.ts";
import { correlationHash } from "../../../packages/protocol/src/diagnostic-context.ts";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executionOutcome, executionOutcomes, type ExecutionOutcome } from "../../../packages/protocol/src/execution-outcome.ts";
import { performance } from "node:perf_hooks";

export type ToolOutcome = "success" | "error" | "partial" | "cancelled";
export type ResultDiagnostic = { trace?: Trace; finalValidationFailed?: boolean; resultPreparationFailed?: boolean; execution?: Partial<Record<ExecutionOutcome, number>>; requestErrors?: number };
type Series = { finalValidationFailures: number; resultPreparationFailures: number; execution: Record<ExecutionOutcome, number>; requestErrors: number; tool: string; device: string; count: number; errors: number; partial: number; cancelled: number; totalMs: number; maxMs: number; samples: number[]; next: number };
const round = (n: number) => Math.round(n * 100) / 100;

/** Bounded, process-local observations; never stores arguments, output or error messages. */
export class ToolDiagnostics {
  readonly maxSeries: number;
  readonly sampleLimit: number;
  private readonly devices: Set<string>;
  private readonly series = new Map<string, Series>();
  private overflow = 0;
  private readonly traces: Array<{ tool: string; trace: Trace }> = [];
  private readonly waitReports: Array<{ requestHash: string; source: "client" | "orchestrator"; observedAt: string }> = [];
  private waitExpiryReports = 0;
  reportWaitExpiry(requestId: string, source: "client" | "orchestrator") {
    this.waitExpiryReports++;
    this.waitReports.push({ requestHash: correlationHash(requestId), source, observedAt: new Date().toISOString() });
    if (this.waitReports.length > this.sampleLimit) this.waitReports.shift();
  }
  constructor(devices: string[] = [], maxSeries = 256, sampleLimit = 128) {
    this.devices = new Set(devices);
    this.maxSeries = Math.max(1, Math.min(1024, Math.floor(maxSeries)));
    this.sampleLimit = Math.max(1, Math.min(1024, Math.floor(sampleLimit)));
  }
  record(tool: string, args: unknown, elapsedMs: number, outcome: ToolOutcome, detail: ResultDiagnostic = {}): void {
    if (detail.trace) {
      this.traces.push({ tool, trace: structuredClone(detail.trace) });
      if (this.traces.length > this.sampleLimit) this.traces.shift();
    }
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const device = typeof input.device === "string" ? (this.devices.has(input.device) ? input.device : "unknown")
      : Array.isArray(input.devices) || Array.isArray(input.items) ? "batch" : "controller";
    const key = `${tool}\0${device}`;
    let value = this.series.get(key);
    if (!value) {
      if (this.series.size >= this.maxSeries) { this.overflow++; return; }
      value = { finalValidationFailures: 0, resultPreparationFailures: 0, execution: Object.fromEntries(executionOutcomes.map(key => [key, 0])) as Record<ExecutionOutcome, number>, requestErrors: 0, tool, device, count: 0, errors: 0, partial: 0, cancelled: 0, totalMs: 0, maxMs: 0, samples: [], next: 0 };
      this.series.set(key, value);
    }
    const duration = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    value.finalValidationFailures += Number(detail.finalValidationFailed === true);
    value.resultPreparationFailures += Number(detail.resultPreparationFailed === true);
    for (const key of executionOutcomes) {
      const count = detail.execution?.[key];
      if (Number.isSafeInteger(count) && count! >= 0) value.execution[key] += count!;
    }
    if (Number.isSafeInteger(detail.requestErrors) && detail.requestErrors! >= 0) value.requestErrors += detail.requestErrors!;
    value.count++; value.errors += Number(outcome === "error"); value.partial += Number(outcome === "partial");
    value.cancelled += Number(outcome === "cancelled"); value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration);
    if (value.samples.length < this.sampleLimit) value.samples.push(duration);
    else { value.samples[value.next] = duration; value.next = (value.next + 1) % this.sampleLimit; }
  }
  snapshot() {
    return { observedAt: new Date().toISOString(), traces: structuredClone(this.traces), waitExpiryReports: this.waitExpiryReports,
      waitReports: [...this.waitReports], waitExpiryScope: "Explicit caller reports only; caller disconnect is not proof of expiry. RC agent request timeout is separate. UI/platform cause and acceptance are unknown.",
      stageScope: "Durations may overlap; agentRequest includes remote execution/wait. queueMs=null means pre-handler queue is not observable.", scope: "controller handler and final validation; client acceptance unknown; effect verification not inferred", sampleWindow: "last completed calls per series", maxSeries: this.maxSeries, sampleLimit: this.sampleLimit, overflowCalls: this.overflow,
      series: [...this.series.values()].map(v => {
        const samples = [...v.samples].sort((a, b) => a - b);
        const percentile = (p: number) => round(samples[Math.max(0, Math.ceil(samples.length * p) - 1)] ?? 0);
        return { finalValidationFailures: v.finalValidationFailures, resultPreparationFailures: v.resultPreparationFailures, execution: { ...v.execution }, requestErrors: v.requestErrors, tool: v.tool, device: v.device, count: v.count, errors: v.errors, partial: v.partial, cancelled: v.cancelled,
          averageMs: round(samples.reduce((sum, sample) => sum + sample, 0) / Math.max(1, samples.length)), maxMs: round(samples.at(-1) ?? 0), lifetimeAverageMs: round(v.totalMs / v.count), lifetimeMaxMs: round(v.maxMs), sampledCalls: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) };
      }) };
  }
}
const instances = new WeakMap<object, ToolDiagnostics>();
export function diagnosticsFor(client: { devices: Array<{ name: string }> }): ToolDiagnostics {
  let value = instances.get(client);
  if (!value) { value = new ToolDiagnostics(client.devices.map(d => d.name)); instances.set(client, value); }
  return value;
}
export function toolOutcome(result: unknown, structured: Record<string, unknown>, signal?: AbortSignal, tool?: string): ToolOutcome {
  if (signal?.aborted || structured.kind === "cancelled") return "cancelled";
  if (tool === "exec") {
    const execution = executionOutcome(structured);
    if (execution === "cancelled") return "cancelled";
    if (execution !== "exit_zero") return "error";
  }
  if (tool === "batch_exec" && structured.executionPartial === true) return "partial";
  if ((result as { isError?: boolean } | null)?.isError || structured.ok === false || tool === undefined && typeof structured.code === "number" && structured.code !== 0) return "error";
  if (structured.partial === true || Array.isArray(structured.errors) && structured.errors.length > 0) return "partial";
  if (Array.isArray(structured.items) && structured.items.some(item => item && item.ok === false)) return "partial";
  if (Array.isArray(structured.devices) && structured.devices.some(d => d && (d.online === false || d.metricsStatus === "unavailable" || d.metricsStatus === "partial" || Array.isArray(d.errors) && d.errors.length > 0))) return "partial";
  return "success";
}

type ProgressExtra = { signal?: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification?: (notification: any) => Promise<void> };
const progressTools = new Set(["job_wait", "job_output_since", "fleet_status"]);
/** Optional elapsed/stage updates, not estimated job completion. No polling or extra agent work. */
export function startToolProgress(name: string, extra?: ProgressExtra): () => void {
  const token = extra?._meta?.progressToken;
  if (!progressTools.has(name) || !(typeof token === "string" || typeof token === "number" && Number.isInteger(token)) || !extra?.sendNotification || extra.signal?.aborted) return () => {};
  const started = performance.now(); let active = true; let pending = false; let previous = -1;
  const notify = () => {
    if (!active || pending || extra.signal?.aborted) return;
    const elapsedMs = Math.max(0, Math.floor(performance.now() - started));
    const progress = Math.max(previous + 1, elapsedMs); previous = progress; pending = true;
    const message = name === "fleet_status" ? `Checking device availability; elapsed ${elapsedMs} ms.`
      : `Waiting for durable job output or completion; elapsed ${elapsedMs} ms. Cancelling this wait does not stop the job.`;
    try { Promise.resolve(extra.sendNotification!({ method: "notifications/progress", params: { progressToken: token, progress, message } })).catch(() => {}).finally(() => { pending = false; }); }
    catch { pending = false; }
  };
  const timer = setInterval(notify, 1000); timer.unref();
  const stop = () => { active = false; clearInterval(timer); extra.signal?.removeEventListener("abort", stop); };
  extra.signal?.addEventListener("abort", stop, { once: true });
  notify(); return stop;
}

export function registerWaitDiagnostics(server: McpServer, diagnostics: ToolDiagnostics) {
  server.registerTool("diagnostic_wait_report", {
    description: "Record an explicit client/orchestrator wait-expiry report for correlation. This is caller-reported evidence, not proof of handler timeout or platform acceptance.",
    inputSchema: z.object({ requestId: z.string().min(1).max(200), source: z.enum(["client", "orchestrator"]) }).strict(),
    outputSchema: z.object({ recorded: z.literal(true), evidence: z.literal("caller_reported"), clientAcceptance: z.literal("unknown"), ...resultMetadataFields }).strict(),
  }, async ({ requestId, source }) => {
    diagnostics.reportWaitExpiry(requestId, source);
    const value = { recorded: true as const, evidence: "caller_reported" as const, clientAcceptance: "unknown" as const };
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value };
  });
}
