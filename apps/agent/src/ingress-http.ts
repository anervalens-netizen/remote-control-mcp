import type { FastifyInstance, FastifyRequest } from "fastify";
import { IngressObserver, type IngressHandle, type IngressIdentity } from "./ingress-observer.ts";
import { encodeIngressHeader, ingressCorrelationHeader, ingressReceiptHeader, parseIngressCorrelation, ingressQuerySchema } from "../../../packages/protocol/src/ingress-correlation.ts";

export type AgentIngressOptions = {
  token?: string; allowUnauthenticated: boolean; identity: IngressIdentity;
  instanceId: string; stateDirectory?: string; retentionDays?: number;
};


/** Runs before authentication, so denied, direct and controller traffic all count.
 * Only authenticated holders can retrieve detail or receive correlation receipts. */
export function registerAgentIngress(app: FastifyInstance, options: AgentIngressOptions) {
  const observer = new IngressObserver({
    stateDirectory: options.stateDirectory, identity: options.identity,
    instanceId: options.instanceId, knownRoutes: [], retentionDays: options.retentionDays,
  });
  const handles = new WeakMap<FastifyRequest, IngressHandle>();
  let hookErrors = 0;
  const guarded = (action: () => void) => { try { action(); } catch { hookErrors++; } };
  const verified = (request: FastifyRequest) => Boolean(options.token) && request.headers.authorization === "Bearer " + options.token;
  app.addHook("onRoute", route => { observer.addKnownRoute(route.url); });
  app.addHook("onRequest", async (request, reply) => {
    guarded(() => {
      const authenticated = verified(request);
      const publicHealth = request.url === "/health";
      const correlation = parseIngressCorrelation(request.headers[ingressCorrelationHeader]);
      const handle = observer.begin({
        route: request.routeOptions.url ?? "other", method: request.method,
        entryPoint: correlation.value ? "controller_claimed" : "unattributed",
        authentication: authenticated ? "bearer_verified" : !publicHealth && !options.allowUnauthenticated ? "rejected" : "not_verified",
        correlation: correlation.value, correlationInvalid: correlation.invalid,
      });
      handles.set(request, handle);
      if (authenticated) reply.header(ingressReceiptHeader, encodeIngressHeader({
        version: 1, instanceId: handle.instanceId, sequence: handle.sequence, eventId: handle.eventId,
        ...(correlation.value ? { dispatchId: correlation.value.dispatchId } : {}),
      }));
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) guarded(() => observer.finish(handle, { outcome: "disconnected" }));
      });
    });
  });
  app.addHook("onResponse", async (request, reply) => {
    const handle = handles.get(request);
    if (handle) guarded(() => observer.finish(handle, { statusCode: reply.statusCode, outcome: "response" }));
  });
  app.addHook("onTimeout", async request => {
    const handle = handles.get(request);
    if (handle) guarded(() => observer.finish(handle, { outcome: "timeout" }));
  });
  app.addHook("onRequestAbort", async request => {
    const handle = handles.get(request);
    if (handle) guarded(() => observer.finish(handle, { outcome: "disconnected" }));
  });
  app.addHook("onClose", async () => { observer.close(); });
  app.post("/v1/observations/ingress", async (request, reply) => {
    // Deliberate unauthenticated workload mode does not publish private history.
    if (!verified(request)) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ingressQuerySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const query = parsed.data;
    const snapshot = observer.snapshot({ sampleOffset: query.sampleOffset, sampleLimit: query.sampleLimit ?? 16 });
    const seriesOffset = Math.min(query.seriesOffset ?? 0, snapshot.series.length);
    const seriesLimit = query.seriesLimit ?? 0;
    const days = [...snapshot.history.days].reverse();
    const historyOffset = Math.min(query.historyOffset ?? 0, days.length);
    const historyLimit = query.historyLimit ?? 7;
    return { ...snapshot,
      series: snapshot.series.slice(seriesOffset, seriesOffset + seriesLimit),
      seriesPage: { offset: seriesOffset, limit: seriesLimit, total: snapshot.series.length,
        nextOffset: seriesOffset + seriesLimit < snapshot.series.length && seriesLimit > 0 ? seriesOffset + seriesLimit : null },
      coverage: { ...snapshot.coverage, processCountsComplete: snapshot.coverage.processCountsComplete && hookErrors === 0, hookErrors },
      history: { ...snapshot.history, partial: snapshot.history.partial || hookErrors > 0, days: days.slice(historyOffset, historyOffset + historyLimit),
        page: { offset: historyOffset, limit: historyLimit, total: days.length,
          nextOffset: historyOffset + historyLimit < days.length && historyLimit > 0 ? historyOffset + historyLimit : null },
        order: "date_descending" },
      hookErrors,
      authenticationScope: "bearer_verified identifies a shared credential holder. Origin labels and correlation are caller-declared; no original client or person is authenticated.",
      responseScope: "A response finish means local HTTP completion, not client consumption or independently verified effects.",
    };
  });
  return observer;
}
