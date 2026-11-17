import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingressCorrelationSchema, ingressReceiptSchema } from "../../../packages/protocol/src/ingress-correlation.ts";
import { reconcileIngressSamples, type AgentDispatchObserver, type DispatchSample } from "./agent-dispatch-observer.ts";

const count = z.number().int().nonnegative().safe();
const identity = z.enum(["owner", "root", "interactive"]);
// Strip untrusted extra fields. In particular never retain arbitrary producer
// errors, routes, paths, results or history strings in a window.
const boundarySchema = z.object({
  version: z.literal(1), windowCollectionVersion: z.literal(1), instanceId: z.string().uuid(), identity, sequence: count,
  observedAt: z.string().datetime(), counterScope: z.literal("current_process"),
  totals: z.object({ received: count }),
  coverage: z.object({ processCountsComplete: z.boolean(), hookErrors: count,
    faults: z.array(z.enum(["state_unavailable", "state_corrupt", "state_identity_mismatch", "persistence_failed",
      "state_over_budget", "clock_regressed", "counter_saturated", "invalid_duration", "closed_with_inflight",
      "state_writer_locked", "state_writer_lost", "state_writer_release_failed"])).max(12) }),
  history: z.object({ retentionDays: count.max(90), collectionStartedAt: z.string().datetime(),
    gaps: z.array(z.unknown()).max(16), omittedGaps: count }),
  sampleCoverage: z.object({ retained: count.max(256), omitted: count, limit: count.max(256) }),
  samples: z.array(z.unknown()).max(256),
}).refine(v => v.sequence === v.totals.received && v.sampleCoverage.retained <= v.sampleCoverage.limit &&
  v.sampleCoverage.retained + v.sampleCoverage.omitted === v.sequence);
type Boundary = Omit<z.infer<typeof boundarySchema>, "samples" | "history"> & {
  history: { retentionDays: number; collectionStartedAt: string; retainedGapCount: number; omittedGaps: number };
};
const eventSchema = z.object({ eventId: z.string().max(80), instanceId: z.string().uuid(), sequence: count,
  identity, correlation: ingressCorrelationSchema.optional(), correlationInvalid: z.boolean() });
type Event = { eventId: string; correlation?: z.infer<typeof ingressCorrelationSchema> };
type Window = {
  id: string; controllerErrorsAtStart: number; device: string; identity: z.infer<typeof identity>; expiresAt: number; busy: boolean;
  start?: Boundary; end?: Boundary; latest?: Boundary; state: "opening" | "active" | "closed" | "restart";
  dispatches: Map<string, DispatchSample>; events: Map<string, Event>; conflicts: Set<string>; dispatchConflicts: Set<string>;
  droppedDispatchObservations: number; droppedEventObservations: number; invalidEvents: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  duplicateEvents: number; sampleAfterSequence: number; failedReads: number; lateDispatchObservations: number; lateReceiptDeliveries: number; coverageGap: boolean;
  lastReadFailure?: "identity_mismatch"; closeDeferred: boolean;
};
export const windowLimits = { windows: 8, dispatches: 256, events: 256, ttlMs: 900_000, detailPage: 16 } as const;

/** Process-memory diagnostic evidence only; never an execution/recovery store. */
export class UsageWindows {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;
  private readonly observer: AgentDispatchObserver;
  constructor(observer: AgentDispatchObserver, now = Date.now) {
    this.now = now; this.observer = observer;
    observer.observe(sample => {
      this.prune();
      for (const w of this.windows.values()) {
        if (sample.device !== w.device || sample.identity !== w.identity) continue;
        if (w.state === "restart") continue;
        if (w.end && !w.dispatches.has(sample.dispatchId) && (!sample.receipt || sample.receipt.instanceId !== w.end.instanceId ||
          sample.receipt.sequence <= w.start!.sequence || sample.receipt.sequence > w.end.sequence)) continue;
        if (!w.dispatches.has(sample.dispatchId) && w.dispatches.size >= windowLimits.dispatches) {
          w.droppedDispatchObservations++; continue;
        }
        const previous = w.dispatches.get(sample.dispatchId);
        const immutable = (d: DispatchSample) => JSON.stringify({ device: d.device, identity: d.identity,
          route: d.route, startedAt: d.startedAt, correlation: d.correlation });
        if (previous && (immutable(previous) !== immutable(sample) || previous.receipt && sample.receipt &&
          JSON.stringify(previous.receipt) !== JSON.stringify(sample.receipt))) {
          w.dispatchConflicts.add(sample.dispatchId); continue;
        }
        if (!previous?.receipt && sample.receipt && w.latest && sample.receipt.instanceId === w.latest.instanceId &&
          sample.receipt.sequence > (w.start?.sequence ?? w.latest.sequence) && sample.receipt.sequence <= w.latest.sequence) w.lateReceiptDeliveries++;
        if (w.end) w.lateDispatchObservations++;
        w.dispatches.set(sample.dispatchId, sample);
      }
    });
  }
  private prune() {
    for (const [id, w] of this.windows) if (w.expiresAt <= this.now()) { clearTimeout(w.expiryTimer); this.windows.delete(id); }
  }
  open(device: string, selected: Window["identity"]) {
    this.prune();
    if (this.windows.size >= windowLimits.windows) throw new Error("usage_window_capacity");
    const w: Window = { id: randomUUID(), controllerErrorsAtStart: this.observer.observationErrors, device, identity: selected, expiresAt: this.now() + windowLimits.ttlMs,
      busy: false, state: "opening", dispatches: new Map(), events: new Map(), conflicts: new Set(), dispatchConflicts: new Set(),
      droppedDispatchObservations: 0, droppedEventObservations: 0, invalidEvents: 0, duplicateEvents: 0,
      sampleAfterSequence: 0, failedReads: 0, lateDispatchObservations: 0, lateReceiptDeliveries: 0, coverageGap: false, closeDeferred: false };
    this.windows.set(w.id, w);
    w.expiryTimer = setTimeout(() => { this.windows.delete(w.id); }, windowLimits.ttlMs);
    w.expiryTimer.unref();
    return w;
  }
  get(id: string, device: string, selected: Window["identity"]) {
    this.prune();
    const w = this.windows.get(id);
    if (!w || w.device !== device || w.identity !== selected) throw new Error("usage_window_unavailable");
    return w;
  }
  discard(w: Window) { clearTimeout(w.expiryTimer); this.windows.delete(w.id); }
  ingest(w: Window, raw: unknown, close: boolean) {
    const parsed = boundarySchema.safeParse(raw);
    w.lastReadFailure = undefined;
    if (!parsed.success) return false;
    if (parsed.data.identity !== w.identity) { w.lastReadFailure = "identity_mismatch"; return false; }
    const { samples, history, ...base } = parsed.data;
    const b: Boundary = { ...base, history: { retentionDays: history.retentionDays,
      collectionStartedAt: history.collectionStartedAt, retainedGapCount: history.gaps.length, omittedGaps: history.omittedGaps } };
    if (w.start && b.instanceId !== w.start.instanceId) { w.latest = b; w.state = "restart"; return true; }
    if (w.latest && (b.sequence < w.latest.sequence || b.observedAt < w.latest.observedAt)) return false;
    w.coverageGap ||= !b.coverage.processCountsComplete || b.coverage.hookErrors > 0 || b.coverage.faults.includes("counter_saturated");
    if (!w.start) { w.start = b; w.sampleAfterSequence = b.sequence; w.state = "active"; }
    w.latest = b;
    const markConflict = (eventId: string) => {
      if (w.conflicts.has(eventId) || w.conflicts.size < windowLimits.events) w.conflicts.add(eventId);
      else w.coverageGap = true;
    };
    const poison = (raw: unknown) => {
      const id = z.object({ instanceId: z.string().uuid(), sequence: count, eventId: z.string().max(80) }).safeParse(raw);
      if (!id.success) return;
      const { instanceId, sequence, eventId } = id.data;
      if (instanceId !== b.instanceId || sequence <= w.start!.sequence || sequence > b.sequence || eventId !== instanceId + ":" + sequence) return;
      // Advance only when the producer's immutable event locator is valid.
      // Invalid correlation payloads are excluded from reconciliation, but
      // must not pin every subsequent cursor page to the same 32 events.
      markConflict(eventId);
      w.sampleAfterSequence = Math.max(w.sampleAfterSequence, sequence);
    };
    for (const rawEvent of samples) {
      const event = eventSchema.safeParse(rawEvent);
      if (!event.success) { w.invalidEvents++; poison(rawEvent); continue; }
      const e = event.data;
      const receipt = ingressReceiptSchema.safeParse({ version: 1, instanceId: e.instanceId, sequence: e.sequence, eventId: e.eventId });
      if (!receipt.success || e.correlationInvalid || e.identity !== w.identity || e.instanceId !== b.instanceId || e.sequence > b.sequence) { w.invalidEvents++; poison(rawEvent); continue; }
      if (e.sequence <= w.start.sequence) continue;
      w.sampleAfterSequence = Math.max(w.sampleAfterSequence, e.sequence);
      const value: Event = { eventId: e.eventId, ...(e.correlation ? { correlation: e.correlation } : {}) };
      const previous = w.events.get(e.eventId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(value)) markConflict(e.eventId);
        else w.duplicateEvents++;
      } else if (w.events.size < windowLimits.events) w.events.set(e.eventId, value);
      else w.droppedEventObservations++;
    }
    if (close) { w.end = b; w.state = "closed"; w.closeDeferred = false; }
    return true;
  }
  /** Freeze only a fully paged current boundary. An unfinished close remains
   * active and can be retried without permanently losing the last 32-event page. */
  finishClose(w: Window) {
    if (w.state !== "active" || !w.latest || !w.start || w.sampleAfterSequence < w.latest.sequence) return false;
    w.end = w.latest; w.state = "closed"; w.closeDeferred = false;
    return true;
  }
  report(w: Window, offset = 0, limit = 0) {
    const controllerObservationErrors = this.observer.observationErrors - w.controllerErrorsAtStart;
    const end = w.end ?? w.latest;
    const comparable = Boolean(w.start && end && w.state !== "restart");
    const denominator = comparable ? end!.sequence - w.start!.sequence : null;
    const receiptBindings = new Map<string, number>();
    for (const d of w.dispatches.values()) if (d.receipt && comparable && d.receipt.instanceId === w.start!.instanceId &&
      d.receipt.sequence > w.start!.sequence && d.receipt.sequence <= end!.sequence)
      receiptBindings.set(d.receipt.eventId, (receiptBindings.get(d.receipt.eventId) ?? 0) + 1);
    const duplicateReceiptBindings = [...receiptBindings.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
    const conflictingReceiptEvents = new Set([...receiptBindings].filter(([, n]) => n > 1).map(([id]) => id));
    const events = [...w.events.values()].filter(e => !w.conflicts.has(e.eventId) && !conflictingReceiptEvents.has(e.eventId));
    const dispatches = [...w.dispatches.values()].filter(d => !w.dispatchConflicts.has(d.dispatchId) && d.receipt && comparable &&
      d.receipt.instanceId === w.start!.instanceId && d.receipt.sequence > w.start!.sequence && d.receipt.sequence <= end!.sequence);
    const base = denominator === null ? null : reconcileIngressSamples(denominator, events, dispatches);
    const reconciliation = base && { ...base,
      unsampledMeaning: "No valid assignable event detail, including excluded conflicting identities. missingEventDetail separately counts absent identities; cause is not inferred.", conflictingAgentEvents: w.conflicts.size,
      conflictingDispatches: w.dispatchConflicts.size, inconsistent: base.inconsistent || conflictingReceiptEvents.size > 0 || w.conflicts.size > 0 || w.dispatchConflicts.size > 0 };
    const details = [...w.dispatches.values()];
    const receiptInvalid = [...w.dispatches.values()].filter(d => d.receiptState === "invalid").length;
    const receiptMissing = [...w.dispatches.values()].filter(d => d.receiptState === "missing" || !d.receiptState && Boolean(d.finishedAt)).length;
    const receiptPending = [...w.dispatches.values()].filter(d => !d.receiptState && !d.finishedAt).length;
    const missing = denominator === null ? null : denominator - w.events.size;
    const evictionCutoff = end ? end.sequence - end.sampleCoverage.retained : 0;
    const missingNoLongerRetainedAtAgent = comparable ? Math.max(0, evictionCutoff - w.start!.sequence) -
      [...w.events.keys()].filter(id => Number(id.split(":")[1]) <= evictionCutoff).length : null;
    const detailsComplete = comparable && missing === 0 && !w.coverageGap && !w.conflicts.size &&
      !w.invalidEvents && !duplicateReceiptBindings && !receiptPending && !controllerObservationErrors && !w.dispatchConflicts.size && !receiptInvalid && !w.droppedDispatchObservations && !w.droppedEventObservations;
    return {
      version: 1, windowId: w.id, device: w.device, identity: w.identity, state: w.state,
      controllerPersistence: "process_memory", expiresAt: new Date(w.expiresAt).toISOString(), timezone: "UTC", limits: windowLimits,
      start: w.start ?? null, end: w.end ?? null, latest: w.latest ?? null,
      boundary: "Agent arrivals with start.sequence < sequence <= end.sequence on one instance. Opening read excluded; closing and intermediate diagnostic reads included.",
      agentDenominator: denominator, collectionResidual: base ? base.agentTotal - base.attributed - base.unmatchedObserved : null, denominatorExact: comparable && !w.coverageGap, reconciliation, missingEventDetail: missing, conflictingAgentEvents: w.conflicts.size,
      missingNoLongerRetainedAtAgent, missingStillRetainedOrLate: missing === null ? null : missing - missingNoLongerRetainedAtAgent!,
      lateAgentEvents: "No agent collection after close; late/missing arrival detail is not reconstructed.",
      invalidEventObservations: w.invalidEvents, duplicateEventDeliveries: w.duplicateEvents,
      droppedDispatchObservations: w.droppedDispatchObservations, droppedEventObservations: w.droppedEventObservations,
      duplicateReceiptBindings, conflictingReceiptEvents: conflictingReceiptEvents.size,
      receiptInvalid, receiptMissing, receiptPending, controllerObservationErrors, nextSampleAfterSequence: w.sampleAfterSequence,
      lateReceiptDeliveries: w.lateReceiptDeliveries, lateDispatchObservations: w.lateDispatchObservations, failedReads: w.failedReads,
      closeDeferred: w.closeDeferred, agentSequencesBeyondCursor: end ? Math.max(0, end.sequence - w.sampleAfterSequence) : null,
      processRestart: w.state === "restart", currentCoverageGap: w.coverageGap, detailsComplete,
      complete: w.state === "closed" && detailsComplete && !reconciliation?.inconsistent,
      detailPage: { offset, limit, total: details.length, nextOffset: limit > 0 && offset + limit < details.length ? offset + limit : null },
      dispatches: details.slice(offset, offset + limit),
      detailScope: "Original selected-peer envelopes observed during retention, including requests outside the agent sequence window or with unknown arrival sequence. Reconciliation uses only in-window receipts; missing/invalid receipt counts cover retained envelopes.",
      limitsMeaning: "Dropped observations are not unique requests. Missing detail may be evicted, uncollected or late; cause unknown. Late dispatch updates can improve a closed report until expiry. No background polling; collect frequently. Restart invalidates the denominator; controller restart/expiry loses windows.",
      trust: "Configured peer and shared bearer are a diagnostic trust domain, not source attestation, authorization, effect proof or client acceptance. Caller-declared correlation is not an authenticated origin.",
    };
  }
}
