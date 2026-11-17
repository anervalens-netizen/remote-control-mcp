import { randomUUID } from "node:crypto";
import { ingressReceiptSchema, ingressCorrelationSchema, parseIngressReceipt, type IngressCorrelation, type IngressReceipt } from "../../../packages/protocol/src/ingress-correlation.ts";
import type { AgentClient, AgentEndpointContext } from "./agent-client.ts";

type Outcome = "success" | "http" | "network" | "protocol" | "timeout" | "cancelled";
type Counts = { started: number; finished: number; responses: number; httpErrors: number; networkErrors: number; protocolErrors: number; timeouts: number; cancelled: number; receiptMatched: number; receiptMissing: number; receiptInvalid: number; totalMs: number; maxMs: number };
const counts = (): Counts => ({ started: 0, finished: 0, responses: 0, httpErrors: 0, networkErrors: 0, protocolErrors: 0, timeouts: 0, cancelled: 0, receiptMatched: 0, receiptMissing: 0, receiptInvalid: 0, totalMs: 0, maxMs: 0 });
type Peer = { device: string; identity: "root" | "owner" | "interactive"; counts: Counts };
export type DispatchSample = {
  dispatchId: string; device: string; identity: Peer["identity"]; route: string;
  startedAt: string; finishedAt?: string; durationMs?: number; outcome?: Outcome;
  statusCode?: number; receipt?: IngressReceipt; receiptState?: "matched" | "missing" | "invalid";
  correlation: IngressCorrelation;
};
export type DispatchHandle = { sample: DispatchSample; peer?: Peer; started: number; finished: boolean; responded: boolean };
const families = new Set(["coordination", "deploy", "desktop", "docker", "exec", "fs", "gpu", "info", "jobs", "network", "packages", "power", "processes", "project", "pty", "repo", "service", "storage", "metrics", "search", "browser", "observations", "wake"]);
/** Fixed categories, never a path/query supplied by a caller. */
function routeCategory(route: string) {
  const pathname = route.split(/[?#]/, 1)[0]!;
  if (pathname === "/health" || pathname === "/health/details") return "/health";
  const family = pathname.split("/")[2];
  return pathname.startsWith("/v1/") && family && families.has(family) ? "/v1/" + family : "other";
}

/** All HTTP attempts count, even when the operation journal refuses admission.
 * Samples are optional diagnostic detail and never the denominator. */
export class AgentDispatchObserver {
  readonly instanceId = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly peers = new Map<string, Peer>();
  private readonly totals = counts();
  private readonly samples: DispatchSample[] = [];
  private overflowCalls = 0;
  observationErrors = 0;
  private readonly listeners = new Set<(sample: DispatchSample) => void>();
  observe(listener: (sample: DispatchSample) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(sample: DispatchSample) {
    for (const listener of this.listeners) {
      try { listener(structuredClone(sample)); } catch { this.observationErrors = Math.min(Number.MAX_SAFE_INTEGER, this.observationErrors + 1); }
    }
  }
  readonly sampleLimit: number;
  readonly maxPeers: number;
  constructor(sampleLimit = 128, maxPeers = 256) {
    this.sampleLimit = Math.max(1, Math.min(256, Math.floor(sampleLimit) || 128));
    this.maxPeers = Math.max(1, Math.min(1024, Math.floor(maxPeers) || 256));
  }
  begin(device: string, context: AgentEndpointContext, route: string, correlation: IngressCorrelation): DispatchHandle {
    const identity = context === "system" ? "root" : context === "user" ? "owner" : "interactive";
    const key = device + "\0" + identity;
    let peer = this.peers.get(key);
    if (!peer && this.peers.size < this.maxPeers) {
      peer = { device, identity, counts: counts() }; this.peers.set(key, peer);
    }
    if (!peer) this.overflowCalls++;
    this.totals.started++; if (peer) peer.counts.started++;
    const handle: DispatchHandle = { sample: { dispatchId: correlation.dispatchId, device, identity, route: routeCategory(route), startedAt: new Date().toISOString(), correlation: structuredClone(correlation) },
      peer, started: performance.now(), finished: false, responded: false };
    this.publish(handle.sample);
    return handle;
  }
  response(handle: DispatchHandle, status: number, header: unknown) {
    if (handle.responded || handle.finished) return;
    handle.responded = true;
    const parsed = parseIngressReceipt(header);
    const matched = parsed.value?.dispatchId === handle.sample.dispatchId;
    const state = parsed.invalid || parsed.value && !matched ? "invalid" : matched ? "matched" : "missing";
    handle.sample.statusCode = Number.isInteger(status) ? status : undefined;
    handle.sample.receiptState = state;
    if (matched) handle.sample.receipt = parsed.value;
    this.publish(handle.sample);
    for (const target of [this.totals, handle.peer?.counts]) if (target) {
      target.responses++;
      target[state === "matched" ? "receiptMatched" : state === "invalid" ? "receiptInvalid" : "receiptMissing"]++;
    }
  }
  finish(handle: DispatchHandle, outcome: Outcome): boolean {
    if (handle.finished) return false;
    handle.finished = true;
    const durationMs = Math.max(0, performance.now() - handle.started);
    Object.assign(handle.sample, { finishedAt: new Date().toISOString(), durationMs, outcome });
    for (const target of [this.totals, handle.peer?.counts]) if (target) {
      target.finished++; target.totalMs += durationMs; target.maxMs = Math.max(target.maxMs, durationMs);
      if (outcome === "http") target.httpErrors++;
      if (outcome === "network") target.networkErrors++;
      if (outcome === "protocol") target.protocolErrors++;
      if (outcome === "timeout") target.timeouts++;
      if (outcome === "cancelled") target.cancelled++;
    }
    this.publish(handle.sample);
    this.samples.push(structuredClone(handle.sample));
    if (this.samples.length > this.sampleLimit) this.samples.shift();
    return true;
  }
  snapshot(device?: string, identity?: Peer["identity"], options: { sampleOffset?: number; sampleLimit?: number } = {}) {
    const peers = [...this.peers.values()].filter(p => (!device || p.device === device) && (!identity || p.identity === identity));
    const samples = this.samples.filter(s => (!device || s.device === device) && (!identity || s.identity === identity));
    const offset = Math.min(samples.length, Math.max(0, Math.floor(options.sampleOffset ?? 0)));
    const limit = Math.min(this.sampleLimit, Math.max(0, Math.floor(options.sampleLimit ?? this.sampleLimit)));
    return {
      version: 1 as const, instanceId: this.instanceId, collectionStartedAt: this.startedAt, observedAt: new Date().toISOString(),
      persistence: "process_memory" as const, observationErrors: this.observationErrors, maxPeers: this.maxPeers, sampleLimit: this.sampleLimit, overflowCalls: this.overflowCalls,
      scope: "Controller-to-agent HTTP attempts, including capability probes and raw reads; no execution/task/client acceptance inference.",
      timingScope: "Dispatch duration includes remote execution or wait and body consumption; pre-handler queue is unobserved.",
      attributionScope: "Receipt matches are diagnostic correlation within the configured endpoint/shared-bearer trust domain. They do not attest endpoint identity or prove durable execution/effects/client acceptance. Credential holders can declare correlation and read its metadata.",
      total: structuredClone(this.totals), totalScope: "All controller targets; selected peer counters are separate.", peers: structuredClone(peers),
      samples: structuredClone(samples.slice(offset, offset + limit)),
      samplePage: { offset, limit, total: samples.length, nextOffset: limit > 0 && offset + limit < samples.length ? offset + limit : null },
      sampleCoverage: "Live last-finished dispatches; stable dispatchId and receipt.eventId deduplicate repeated pages. Not a frozen cursor.",
    };
  }
}
const instances = new WeakMap<object, AgentDispatchObserver>();
export function dispatchesFor(client: AgentClient) {
  let value = instances.get(client);
  if (!value) { value = new AgentDispatchObserver(); instances.set(client, value); }
  return value;
}

/** Compare unique receipts in an explicitly supplied complete window. Repeated
 * delivery cannot create requests. Missing samples remain unassigned, never
 * inferred to be direct callers. This function does not reconstruct history. */
export function reconcileIngressSamples(agentTotal: number, agentEvents: Array<{ eventId: string; correlation?: IngressCorrelation }>, dispatches: DispatchSample[]) {
  if (!Number.isSafeInteger(agentTotal) || agentTotal < 0) throw new Error("Invalid ingress denominator");
  const events = new Map<string, { correlation?: IngressCorrelation; fingerprint: string }>();
  const conflicting = new Set<string>();
  let invalidAgentEvents = 0;
  for (const event of agentEvents) {
    const [instanceId, sequenceText, extra] = event.eventId.split(":");
    const identity = ingressReceiptSchema.safeParse({ version: 1, instanceId, sequence: Number(sequenceText), eventId: event.eventId });
    const correlation = event.correlation === undefined ? undefined : ingressCorrelationSchema.safeParse(event.correlation);
    if (extra !== undefined || !identity.success || correlation && !correlation.success) { invalidAgentEvents++; continue; }
    const value = correlation?.success ? correlation.data : undefined;
    const fingerprint = JSON.stringify(value ?? null);
    const previous = events.get(event.eventId);
    if (previous && previous.fingerprint !== fingerprint) conflicting.add(event.eventId);
    else if (!previous) events.set(event.eventId, { correlation: value, fingerprint });
  }
  const bindingByDispatch = new Map<string, string>();
  const conflictingDispatches = new Set<string>();
  const validDispatches: Array<{ dispatchId: string; receipt: IngressReceipt; correlation: IngressCorrelation }> = [];
  let invalidDispatches = 0;
  for (const dispatch of dispatches) {
    if (dispatch.receiptState !== "matched") continue;
    const receipt = ingressReceiptSchema.safeParse(dispatch.receipt);
    const correlation = ingressCorrelationSchema.safeParse(dispatch.correlation);
    if (!receipt.success || !correlation.success || receipt.data.dispatchId !== dispatch.dispatchId || correlation.data.dispatchId !== dispatch.dispatchId) {
      invalidDispatches++; continue;
    }
    const fingerprint = JSON.stringify({ device: dispatch.device, identity: dispatch.identity, route: dispatch.route,
      correlation: correlation.data, receipt: receipt.data });
    const previous = bindingByDispatch.get(dispatch.dispatchId);
    if (previous && previous !== fingerprint) conflictingDispatches.add(dispatch.dispatchId);
    else bindingByDispatch.set(dispatch.dispatchId, fingerprint);
    validDispatches.push({ dispatchId: dispatch.dispatchId, receipt: receipt.data, correlation: correlation.data });
  }
  const matched = new Set<string>();
  for (const dispatch of validDispatches) {
    const receipt = dispatch.receipt;
    if (conflicting.has(receipt.eventId) || conflictingDispatches.has(dispatch.dispatchId)) continue;
    const event = events.get(receipt.eventId);
    if (event?.correlation?.dispatchId === dispatch.dispatchId &&
        JSON.stringify(event.correlation) === JSON.stringify(dispatch.correlation)) matched.add(receipt.eventId);
  }
  const unsampled = Math.max(0, agentTotal - events.size);
  const unmatchedObserved = events.size - matched.size;
  return {
    scope: "Caller-supplied complete window; samples may omit request detail. Labels alone do not establish attribution.",
    agentTotal, uniqueAgentEvents: events.size, attributed: matched.size,
    unmatchedObserved, unsampled, unattributed: unmatchedObserved + unsampled,
    collectionResidual: agentTotal - matched.size - unmatchedObserved - unsampled,
    inconsistent: events.size > agentTotal || invalidAgentEvents > 0 || invalidDispatches > 0 || conflicting.size > 0 || conflictingDispatches.size > 0,
    conflictingAgentEvents: conflicting.size, conflictingDispatches: conflictingDispatches.size, invalidAgentEvents, invalidDispatches,
    unsampledMeaning: "Requests not represented by valid supplied event detail; sampling, collection gaps and late delivery are not distinguished without more evidence.",
    duplicateAgentDeliveries: agentEvents.length - events.size - invalidAgentEvents,
    clientAcceptance: "unknown" as const, effectVerification: "unverified" as const,
  };
}
