import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";

type Rejection = { reason: unknown };
function errorDetails(error: unknown) {
  const value = error as { kind?: unknown; status?: unknown; name?: unknown };
  return {
    kind: typeof value?.kind === "string" ? value.kind : typeof value?.name === "string" ? value.name : "probe_error",
    status: typeof value?.status === "number" ? value.status : null,
  };
}
function transportAnswered(error: unknown): boolean {
  const value = error as { kind?: unknown; status?: unknown };
  return typeof value?.status === "number" || value?.kind === "protocol";
}

export function fleetProbeBudget(requested?: number): number {
  const configured = requested ?? Number(process.env.RCMCP_HEALTH_PROBE_TIMEOUT_MS ?? 1500);
  return Number.isFinite(configured) && configured >= 100 && configured <= 30_000 ? Math.floor(configured) : 1500;
}

/** Read-only availability probe. Its budget never changes effectful command deadlines. */
export async function probeFleetHost(
  client: AgentClient,
  device: string,
  context: AgentEndpointContext,
  timeoutMs: number,
  callerSignal?: AbortSignal,
) {
  callerSignal?.throwIfAborted();
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new DOMException("Fleet probe budget exceeded", "TimeoutError")), timeoutMs);
  timer.unref();
  const signal = callerSignal ? AbortSignal.any([callerSignal, budget.signal]) : budget.signal;
  try {
    const options = { timeoutMs, signal };
    const [infoResult, metricsResult] = await Promise.allSettled([
      Promise.resolve().then(() => client.info(device, context, options)),
      Promise.resolve().then(() => client.requestRoute<Record<string, unknown>>(device, "/v1/metrics?profile=light", undefined, context, options)),
    ]);
    callerSignal?.throwIfAborted();

    const info = infoResult.status === "fulfilled" ? infoResult.value as Record<string, any> : null;
    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value as Record<string, any> : null;
    const rejected = [infoResult, metricsResult].filter((item): item is PromiseRejectedResult => item.status === "rejected");
    const reachable = Boolean(info || metrics || rejected.some((item) => transportAnswered(item.reason)));
    const root = metrics?.rootFilesystem && typeof metrics.rootFilesystem === "object"
      ? metrics.rootFilesystem as Record<string, unknown>
      : null;
    const total = Number(metrics?.totalMemoryBytes ?? info?.totalMemoryBytes ?? 0);
    const free = Number(metrics?.freeMemoryBytes ?? info?.freeMemoryBytes ?? 0);

    const errors = rejected.map((item) => errorDetails(item.reason));
    const metricsStatus = metrics
      ? (metrics.metricsStatus === "partial" ? "partial" : "ok")
      : "unavailable";
    return {
      device,
      online: reachable,
      connectivity: reachable ? "reachable" : "unknown",
      observedAt: new Date().toISOString(),
      probeBudgetMs: timeoutMs,
      readiness: info?.readiness ?? null,
      metricsStatus,
      hostname: metrics?.hostname ?? info?.hostname ?? null,
      platform: metrics?.platform ?? info?.platform ?? null,
      arch: metrics?.arch ?? info?.arch ?? null,
      uptimeSeconds: metrics?.uptimeSeconds ?? null,
      cpuCount: metrics?.cpuCount ?? null,
      cpuModel: metrics?.cpuModel ?? null,
      memoryUsedPercent: total > 0 ? Math.round((1 - free / total) * 1000) / 10 : null,
      rootUsedPercent: root?.usedPercent ?? null,
      rootAvailableBytes: root?.availableBytes ?? null,
      filesystemSampledAt: metrics?.filesystemSampledAt ?? null,
      filesystemAgeMs: metrics?.filesystemAgeMs ?? null,
      ...(Array.isArray(metrics?.warnings) && metrics.warnings.length ? { warnings: metrics.warnings } : {}),
      ...(errors.length ? { errors } : {}),
      ...(!info || !metrics ? {
        reason: reachable
          ? "The agent responded, but readiness or resource metrics are unavailable."
          : "No agent response completed within the read-only probe budget; power state is unknown.",
      } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
