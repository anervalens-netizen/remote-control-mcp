import { performance } from "node:perf_hooks";

export type ToolOutcome = "success" | "error" | "partial" | "cancelled";
type Series = { tool: string; device: string; count: number; errors: number; partial: number; cancelled: number; totalMs: number; maxMs: number; samples: number[]; next: number };
const round = (n: number) => Math.round(n * 100) / 100;

/** Bounded, process-local observations; never stores arguments, output or error messages. */
export class ToolDiagnostics {
  readonly maxSeries: number;
  readonly sampleLimit: number;
  private readonly devices: Set<string>;
  private readonly series = new Map<string, Series>();
  private overflow = 0;
  constructor(devices: string[] = [], maxSeries = 256, sampleLimit = 128) {
    this.devices = new Set(devices);
    this.maxSeries = Math.max(1, Math.min(1024, Math.floor(maxSeries)));
    this.sampleLimit = Math.max(1, Math.min(1024, Math.floor(sampleLimit)));
  }
  record(tool: string, args: unknown, elapsedMs: number, outcome: ToolOutcome): void {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const device = typeof input.device === "string" ? (this.devices.has(input.device) ? input.device : "unknown")
      : Array.isArray(input.devices) || Array.isArray(input.items) ? "batch" : "controller";
    const key = `${tool}\0${device}`;
    let value = this.series.get(key);
    if (!value) {
      if (this.series.size >= this.maxSeries) { this.overflow++; return; }
      value = { tool, device, count: 0, errors: 0, partial: 0, cancelled: 0, totalMs: 0, maxMs: 0, samples: [], next: 0 };
      this.series.set(key, value);
    }
    const duration = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
    value.count++; value.errors += Number(outcome === "error"); value.partial += Number(outcome === "partial");
    value.cancelled += Number(outcome === "cancelled"); value.totalMs += duration; value.maxMs = Math.max(value.maxMs, duration);
    if (value.samples.length < this.sampleLimit) value.samples.push(duration);
    else { value.samples[value.next] = duration; value.next = (value.next + 1) % this.sampleLimit; }
  }
  snapshot() {
    return { observedAt: new Date().toISOString(), scope: "controller tool handlers; not client or total network latency", sampleWindow: "last completed calls per series", maxSeries: this.maxSeries, sampleLimit: this.sampleLimit, overflowCalls: this.overflow,
      series: [...this.series.values()].map(v => {
        const samples = [...v.samples].sort((a, b) => a - b);
        const percentile = (p: number) => round(samples[Math.max(0, Math.ceil(samples.length * p) - 1)] ?? 0);
        return { tool: v.tool, device: v.device, count: v.count, errors: v.errors, partial: v.partial, cancelled: v.cancelled,
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
export function toolOutcome(result: unknown, structured: Record<string, unknown>, signal?: AbortSignal): ToolOutcome {
  if (signal?.aborted || structured.kind === "cancelled") return "cancelled";
  if ((result as { isError?: boolean } | null)?.isError || structured.ok === false || typeof structured.code === "number" && structured.code !== 0) return "error";
  if (structured.partial === true || Array.isArray(structured.errors) && structured.errors.length > 0) return "partial";
  if (Array.isArray(structured.items) && structured.items.some(item => item && item.ok === false)) return "partial";
  if (Array.isArray(structured.devices) && structured.devices.some(d => d && (d.online === false || d.metricsStatus === "unavailable" || d.metricsStatus === "partial"))) return "partial";
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
