import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { atomicWriteText } from "./state.ts";
import { ingressCorrelationSchema, type IngressCorrelation } from "../../../packages/protocol/src/ingress-correlation.ts";
export type { IngressCorrelation } from "../../../packages/protocol/src/ingress-correlation.ts";

export type IngressIdentity = "owner" | "root" | "interactive" | "unknown";
export type IngressEntryPoint = "controller_claimed" | "unattributed";
export type IngressAuthentication = "bearer_verified" | "not_verified" | "rejected";
const uuid = z.string().uuid();
export type IngressStart = {
  route: string; method: string; entryPoint: IngressEntryPoint; authentication: IngressAuthentication;
  correlation?: IngressCorrelation; correlationInvalid?: boolean;
};
export type IngressHandle = Readonly<{ eventId: string; instanceId: string; sequence: number; startedAt: string }>;
export type IngressCompletion = { statusCode?: number; outcome?: "response" | "disconnected" | "timeout" };
type Outcome = NonNullable<IngressCompletion["outcome"]>;
type StatusClass = "informational" | "success" | "redirect" | "clientError" | "serverError" | "unknown";
type Fault = "state_unavailable" | "state_corrupt" | "state_identity_mismatch" | "persistence_failed" |
  "state_over_budget" | "clock_regressed" | "counter_saturated" | "invalid_duration" | "closed_with_inflight" |
  "state_writer_locked" | "state_writer_lost" | "state_writer_release_failed";
const faultSchema = z.enum(["state_unavailable", "state_corrupt", "state_identity_mismatch", "persistence_failed",
  "state_over_budget", "clock_regressed", "counter_saturated", "invalid_duration", "closed_with_inflight",
  "state_writer_locked", "state_writer_lost", "state_writer_release_failed"]);
const count = z.number().int().nonnegative().safe();
const duration = z.number().nonnegative().finite().max(Number.MAX_SAFE_INTEGER);
const statusSchema = z.object({
  informational: count, success: count, redirect: count, clientError: count, serverError: count, unknown: count,
}).strict();
const totalsSchema = z.object({
  received: count, completed: count, response: count, disconnected: count, timeout: count,
  statuses: statusSchema, durationCount: count, totalDurationMs: duration, maxDurationMs: duration,
}).strict();
type Totals = z.infer<typeof totalsSchema>;
const sourceSchema = z.object({
  entryPoint: z.enum(["controller_claimed", "unattributed"]),
  authentication: z.enum(["bearer_verified", "not_verified", "rejected"]),
  received: count, completed: count,
}).strict();
type SourceTotals = z.infer<typeof sourceSchema>;
const validUtcDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const utcTimestampSchema = z.string().datetime().refine(value =>
  validUtcDay(value.slice(0, 10)) && Number.isFinite(Date.parse(value)), "invalid UTC timestamp");
const daySchema = totalsSchema.extend({
  date: z.string().refine(validUtcDay, "invalid UTC calendar day"), sources: z.array(sourceSchema).max(6),
}).strict();
type Day = z.infer<typeof daySchema>;
const gapSchema = z.object({
  reason: z.enum(["unclean_restart", "clean_restart_interval", "writer_continuity_unknown"]),
  from: utcTimestampSchema, to: utcTimestampSchema, previousUnfinished: count,
}).strict();
type Gap = z.infer<typeof gapSchema>;
const stateSchema = z.object({
  version: z.literal(1), identity: z.enum(["owner", "root", "interactive", "unknown"]),
  collectionStartedAt: utcTimestampSchema, lastSavedAt: utcTimestampSchema,
  lastInstanceId: uuid, lastSequence: count, previousUnfinished: count, cleanShutdown: z.boolean(),
  days: z.array(daySchema).max(90), gaps: z.array(gapSchema).max(16), omittedGaps: count,
  faults: z.array(faultSchema).max(12), greatestObservedAt: z.number().finite(),
}).strict();
type Series = Totals & { route: string; method: string; entryPoint: IngressEntryPoint; authentication: IngressAuthentication };
type Sample = IngressHandle & {
  route: string; method: string; entryPoint: IngressEntryPoint; authentication: IngressAuthentication;
  identity: IngressIdentity; correlation?: IngressCorrelation; correlationInvalid: boolean;
  phase: "received" | "finished"; revision: 1 | 2; finishedAt?: string; durationMs?: number;
  outcome?: Outcome; statusCode?: number;
};
type Pending = {
  day: string; monotonicStart: number; finished: boolean; entryPoint: IngressEntryPoint;
  authentication: IngressAuthentication; series?: Series; sample?: Sample;
};
export type IngressObserverOptions = {
  stateDirectory?: string;
  /** Unique for this observer lifetime. Pass the current agent boot UUID, never a persisted/reused ID. */
  instanceId?: string; identity: IngressIdentity; knownRoutes?: string[];
  retentionDays?: number; maxSeries?: number; sampleLimit?: number; maxStateBytes?: number;
  flushIntervalMs?: number; now?: () => number; monotonicNow?: () => number;
};
const DAY_MS = 86_400_000;
const emptyTotals = (): Totals => ({
  received: 0, completed: 0, response: 0, disconnected: 0, timeout: 0,
  statuses: { informational: 0, success: 0, redirect: 0, clientError: 0, serverError: 0, unknown: 0 },
  durationCount: 0, totalDurationMs: 0, maxDurationMs: 0,
});
const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback;
const statusClass = (status: number | undefined): StatusClass => status === undefined ? "unknown"
  : status < 200 ? "informational" : status < 300 ? "success" : status < 400 ? "redirect"
    : status < 500 ? "clientError" : "serverError";

/**
 * Bounded request observations, never execution/recovery state. Counts come from
 * ingress hooks, not sampled traces or replayed logs. One agent owns a directory.
 * Failure to collect/persist telemetry must not fail or replay the request.
 * Claims exclude cooperative writers in a private directory; they do not provide
 * snapshot isolation against administrative namespace replacement.
 */
export class IngressObserver {
  readonly instanceId: string;
  readonly identity: IngressIdentity;
  readonly retentionDays: number;
  readonly maxSeries: number;
  readonly sampleLimit: number;
  readonly maxStateBytes: number;
  readonly flushIntervalMs: number;
  private readonly file?: string;
  private writerFd?: number;
  private writerIdentity?: { dev: number; ino: number };
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly knownRoutes = new Set<string>();
  private readonly pending = new WeakMap<IngressHandle, Pending>();
  private readonly totals = emptyTotals();
  private readonly sources: SourceTotals[] = [];
  private readonly series = new Map<string, Series>();
  private readonly samples: Sample[] = [];
  private readonly days = new Map<string, Day>();
  private readonly faults = new Set<Fault>();
  private readonly gaps: Gap[] = [];
  private omittedGaps = 0;
  private sequence = 0;
  private revision = 0;
  private savedRevision = 0;
  private lastSavedSequence = 0;
  private lastSavedAt: string | null = null;
  private persistenceDisabled = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private collectionStartedAt: string;
  private readonly processStartedAt: string;
  private greatestObservedAt: number;
  private seriesOverflowRequests = 0;
  private malformedCorrelations = 0;
  private duplicateCompletions = 0;
  private lateCompletionsOutsideRetention = 0;
  private startsOutsideRetention = 0;
  private persistenceFailures = 0;
  private flushCount = 0;
  private lastFlushMs = 0;
  private maxFlushMs = 0;
  private retainedBytes = 0;

  constructor(options: IngressObserverOptions) {
    this.instanceId = uuid.safeParse(options.instanceId).success ? options.instanceId! : randomUUID();
    this.identity = ["owner", "root", "interactive", "unknown"].includes(options.identity) ? options.identity : "unknown";
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.retentionDays = bounded(options.retentionDays, 90, 60, 90);
    this.maxSeries = bounded(options.maxSeries, 256, 1, 256);
    this.sampleLimit = bounded(options.sampleLimit, 128, 0, 256);
    this.maxStateBytes = bounded(options.maxStateBytes, 2 * 1024 * 1024, 65_536, 8 * 1024 * 1024);
    this.flushIntervalMs = bounded(options.flushIntervalMs, 1000, 100, 5000);
    const now = this.now();
    this.greatestObservedAt = now;
    this.collectionStartedAt = this.processStartedAt = new Date(now).toISOString();
    for (const route of options.knownRoutes ?? []) this.addKnownRoute(route);
    if (options.stateDirectory) this.file = path.join(options.stateDirectory, "aggregate.json");
    this.acquireWriter();
    this.load();
    this.changed();
    // Establish the new instance's unclean marker before requests are admitted.
    // A failure here is reported and never prevents application startup.
    this.flush();
  }

  private acquireWriter(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      // No PID-based takeover: another observer can be live, or this can be
      // preserved orphan evidence. Only an exclusive create admits a writer.
      this.writerFd = openSync(this.file + ".writer", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600);
      const owned = fstatSync(this.writerFd);
      this.writerIdentity = { dev: owned.dev, ino: owned.ino };
      writeFileSync(this.writerFd, JSON.stringify({
        version: 1, instanceId: this.instanceId, pid: process.pid, createdAt: this.processStartedAt,
      }) + "\n");
      fsyncSync(this.writerFd);
    } catch (error) {
      this.persistenceDisabled = true;
      this.faults.add((error as NodeJS.ErrnoException).code === "EEXIST" ? "state_writer_locked" : "state_unavailable");
      // Partial creation is not a successfully acquired claim. Remove only the
      // inode captured immediately after our exclusive open, then close the fd.
      // If ownership cannot be checked, preserve the path for inspection.
      this.releaseWriter();
    }
  }

  private assertWriter(): void {
    if (!this.file || this.writerFd === undefined || !this.writerIdentity) {
      this.persistenceDisabled = true; this.faults.add("state_writer_lost");
      throw new Error("aggregate writer is unavailable");
    }
    try {
      const current = lstatSync(this.file + ".writer");
      const owned = fstatSync(this.writerFd);
      if (!current.isFile() || owned.dev !== this.writerIdentity.dev || owned.ino !== this.writerIdentity.ino ||
        current.dev !== owned.dev || current.ino !== owned.ino) {
        this.persistenceDisabled = true; this.faults.add("state_writer_lost");
        throw new Error("aggregate writer ownership changed");
      }
    } catch (error) {
      // Missing ownership or an invalid held descriptor is not a retryable
      // publication failure. Never create or reclaim a replacement claim.
      if (["ENOENT", "EBADF"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        this.persistenceDisabled = true; this.faults.add("state_writer_lost");
      }
      throw error;
    }
  }

  private releaseWriter(): void {
    if (!this.file || this.writerFd === undefined) return;
    const fd = this.writerFd;
    try {
      this.assertWriter();
      unlinkSync(this.file + ".writer");
      if (process.platform !== "win32") {
        const directoryFd = openSync(path.dirname(this.file), "r");
        try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
      }
    } catch {
      // A release or its durability could not be established. A remaining claim
      // requires inspection; a replaced claim is never removed.
      this.persistenceDisabled = true; this.faults.add("state_writer_release_failed");
    } finally {
      this.writerFd = undefined; this.writerIdentity = undefined;
      try { closeSync(fd); } catch {
        this.persistenceDisabled = true; this.faults.add("state_writer_release_failed");
      }
    }
  }

  addKnownRoute(route: string): boolean {
    if (this.knownRoutes.has(route)) return true;
    if (this.knownRoutes.size >= 256 || !/^\/[a-zA-Z0-9/:._*\-]{0,127}$/.test(route)) return false;
    this.knownRoutes.add(route);
    return true;
  }

  private add(target: object, key: string, value = 1): void {
    const row = target as Record<string, number>;
    const next = (row[key] ?? 0) + value;
    if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
      row[key] = Number.MAX_SAFE_INTEGER; this.faults.add("counter_saturated");
    } else row[key] = next;
  }

  private time(): number {
    const now = this.now();
    if (now < this.greatestObservedAt) this.faults.add("clock_regressed");
    this.greatestObservedAt = Math.max(this.greatestObservedAt, now);
    return now;
  }

  private cutoff(): string {
    return new Date(this.greatestObservedAt - (this.retentionDays - 1) * DAY_MS).toISOString().slice(0, 10);
  }

  private prune(): void {
    const cutoff = this.cutoff();
    for (const date of this.days.keys()) if (date < cutoff) this.days.delete(date);
  }

  private source(rows: SourceTotals[], entryPoint: IngressEntryPoint, authentication: IngressAuthentication): SourceTotals {
    let row = rows.find(value => value.entryPoint === entryPoint && value.authentication === authentication);
    if (!row) { row = { entryPoint, authentication, received: 0, completed: 0 }; rows.push(row); }
    return row;
  }

  private day(date: string): Day | undefined {
    if (date < this.cutoff()) return undefined;
    let row = this.days.get(date);
    if (!row) { row = { ...emptyTotals(), date, sources: [] }; this.days.set(date, row); }
    return row;
  }

  private changed(): void {
    this.revision++;
    if (!this.closed && this.file && !this.persistenceDisabled && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.flushIntervalMs);
      this.timer.unref();
    }
  }

  begin(input: IngressStart): IngressHandle {
    const now = this.time();
    this.prune();
    const parsed = input.correlation === undefined ? undefined : ingressCorrelationSchema.safeParse(input.correlation);
    const correlationInvalid = input.correlationInvalid === true || parsed?.success === false;
    const correlation = !correlationInvalid && parsed?.success ? parsed.data : undefined;
    if (correlationInvalid) this.malformedCorrelations++;
    const authentication: IngressAuthentication = ["bearer_verified", "rejected"].includes(input.authentication)
      ? input.authentication : "not_verified";
    // A shared bearer proves possession, not a controller identity. The label
    // stays explicitly claimed and unauthenticated correlation is discarded.
    const entryPoint: IngressEntryPoint = input.entryPoint === "controller_claimed" &&
      authentication === "bearer_verified" && correlation ? "controller_claimed" : "unattributed";
    const route = this.knownRoutes.has(input.route) ? input.route : "other";
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(input.method) ? input.method : "OTHER";
    const handle = Object.freeze({
      eventId: `${this.instanceId}:${++this.sequence}`, instanceId: this.instanceId,
      sequence: this.sequence, startedAt: new Date(now).toISOString(),
    });
    const date = handle.startedAt.slice(0, 10);
    const key = [route, method, entryPoint, authentication].join("\0");
    let series = this.series.get(key);
    if (!series && this.series.size < this.maxSeries) {
      series = { ...emptyTotals(), route, method, entryPoint, authentication }; this.series.set(key, series);
    }
    if (!series) this.seriesOverflowRequests++;
    this.add(this.totals, "received");
    this.add(this.source(this.sources, entryPoint, authentication), "received");
    if (series) this.add(series, "received");
    const day = this.day(date);
    if (day) { this.add(day, "received"); this.add(this.source(day.sources, entryPoint, authentication), "received"); }
    else this.startsOutsideRetention++;
    let sample: Sample | undefined;
    if (this.sampleLimit) {
      sample = { ...handle, route, method, entryPoint, authentication, identity: this.identity, correlationInvalid,
        ...(authentication === "bearer_verified" && correlation ? { correlation } : {}), phase: "received", revision: 1 };
      this.samples.push(sample);
      if (this.samples.length > this.sampleLimit) this.samples.shift();
    }
    this.pending.set(handle, { day: date, monotonicStart: this.monotonicNow(), finished: false, entryPoint, authentication, series, sample });
    this.changed();
    return handle;
  }

  finish(handle: IngressHandle, completion: IngressCompletion = {}): boolean {
    const pending = this.pending.get(handle);
    if (!pending) return false;
    if (pending.finished) { this.duplicateCompletions++; return false; }
    pending.finished = true;
    const now = this.time();
    this.prune();
    const observedDuration = this.monotonicNow() - pending.monotonicStart;
    const elapsedMs = Number.isFinite(observedDuration) && observedDuration >= 0
      ? Math.min(Number.MAX_SAFE_INTEGER, observedDuration) : 0;
    if (elapsedMs !== observedDuration) this.faults.add("invalid_duration");
    const outcome: Outcome = completion.outcome === "disconnected" || completion.outcome === "timeout" ? completion.outcome : "response";
    const statusCode = Number.isInteger(completion.statusCode) && completion.statusCode! >= 100 && completion.statusCode! <= 599
      ? completion.statusCode : undefined;
    const update = (row: Totals) => {
      this.add(row, "completed"); this.add(row, outcome);
      this.add(row.statuses, statusClass(statusCode)); this.add(row, "durationCount");
      this.add(row, "totalDurationMs", elapsedMs); row.maxDurationMs = Math.max(row.maxDurationMs, elapsedMs);
    };
    update(this.totals);
    this.add(this.source(this.sources, pending.entryPoint, pending.authentication), "completed");
    if (pending.series) update(pending.series);
    const day = this.days.get(pending.day);
    if (day) { update(day); this.add(this.source(day.sources, pending.entryPoint, pending.authentication), "completed"); }
    else this.lateCompletionsOutsideRetention++;
    if (pending.sample) Object.assign(pending.sample, {
      phase: "finished", revision: 2, finishedAt: new Date(now).toISOString(), durationMs: elapsedMs,
      outcome, ...(statusCode === undefined ? {} : { statusCode }),
    });
    this.changed();
    return true;
  }

  private load(): void {
    if (!this.file) return;
    let fd: number | undefined;
    let loaded: {
      collectionStartedAt: string; greatestObservedAt: number; days: Day[];
      gaps: Gap[]; omittedGaps: number; faults: Set<Fault>; bytes: number;
    } | undefined;
    try {
      // A FIFO must not block before fstat can reject it. O_NONBLOCK does not
      // change regular-file reads; unsupported platforms omit it.
      const nonblocking = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | nonblocking);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > this.maxStateBytes) throw new Error("invalid state shape");
      const buffer = Buffer.alloc(this.maxStateBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const got = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!got) break;
        bytes += got;
      }
      if (bytes > this.maxStateBytes) throw new Error("state over budget");
      const parsed = stateSchema.parse(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
      if (parsed.identity !== this.identity) {
        this.faults.add("state_identity_mismatch"); this.persistenceDisabled = true; return;
      }
      if (new Set(parsed.days.map(day => day.date)).size !== parsed.days.length ||
        parsed.days.some(day => new Set(day.sources.map(source => `${source.entryPoint}:${source.authentication}`)).size !== day.sources.length ||
          day.completed > day.received || day.response + day.disconnected + day.timeout !== day.completed ||
          day.sources.reduce((total, source) => total + source.received, 0) !== day.received ||
          day.sources.reduce((total, source) => total + source.completed, 0) !== day.completed)) {
        throw new Error("inconsistent counters");
      }
      // Validate all persisted time before using it in retention or assigning
      // any live state. A finite number can still be outside Date's range.
      const greatestDate = new Date(parsed.greatestObservedAt).toISOString().slice(0, 10);
      const timestamps = [parsed.collectionStartedAt, parsed.lastSavedAt,
        ...parsed.gaps.flatMap(gap => [gap.from, gap.to])];
      if (!validUtcDay(greatestDate) || timestamps.some(value => Date.parse(value) > parsed.greatestObservedAt) ||
        parsed.days.some(day => day.date > greatestDate)) throw new Error("inconsistent state timestamps");
      // Clock regression can legitimately reverse a gap or move lastSavedAt
      // before collectionStartedAt. Only the observed high-water mark bounds them.
      const greatestObservedAt = Math.max(this.greatestObservedAt, parsed.greatestObservedAt);
      const cutoff = new Date(greatestObservedAt - (this.retentionDays - 1) * DAY_MS).toISOString().slice(0, 10);
      if (!validUtcDay(cutoff)) throw new Error("invalid retention calendar");
      const faults = new Set<Fault>(parsed.faults);
      if (parsed.greatestObservedAt > this.greatestObservedAt) faults.add("clock_regressed");
      const gaps: Gap[] = [...parsed.gaps];
      // Retain the unobserved interval even without write ownership. A blocked
      // observer cannot distinguish an orphan from a live competing writer, so
      // it reports unknown continuity instead of inferring a process restart.
      gaps.push({
        reason: this.persistenceDisabled ? "writer_continuity_unknown"
          : parsed.cleanShutdown ? "clean_restart_interval" : "unclean_restart",
        from: parsed.lastSavedAt, to: this.processStartedAt, previousUnfinished: parsed.previousUnfinished,
      });
      const omittedGaps = parsed.omittedGaps + Math.max(0, gaps.length - 16);
      if (omittedGaps > Number.MAX_SAFE_INTEGER) faults.add("counter_saturated");
      loaded = {
        collectionStartedAt: parsed.collectionStartedAt, greatestObservedAt,
        days: parsed.days.filter(day => day.date >= cutoff), gaps: gaps.slice(-16),
        omittedGaps: Math.min(Number.MAX_SAFE_INTEGER, omittedGaps), faults, bytes,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.persistenceDisabled = true;
        this.faults.add(["EACCES", "EPERM", "EIO"].includes((error as NodeJS.ErrnoException).code ?? "") ? "state_unavailable" : "state_corrupt");
      }
      // Invalid or unreadable evidence stays untouched. No automatic recovery
      // copy, overwrite, log replay, or effect is attempted.
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {
          loaded = undefined; this.persistenceDisabled = true; this.faults.add("state_unavailable");
        }
      }
    }
    // Parsing, derived dates and descriptor cleanup must all succeed before
    // restored data can influence the healthy in-memory observer.
    if (!loaded) return;
    this.collectionStartedAt = loaded.collectionStartedAt;
    this.greatestObservedAt = loaded.greatestObservedAt;
    for (const day of loaded.days) this.days.set(day.date, day);
    for (const fault of loaded.faults) this.faults.add(fault);
    this.gaps.push(...loaded.gaps);
    this.omittedGaps = loaded.omittedGaps;
    this.retainedBytes = loaded.bytes;
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.file || this.persistenceDisabled || this.revision === this.savedRevision) return;
    const start = this.monotonicNow();
    try {
      const savedAt = new Date(this.time()).toISOString();
      this.prune();
      const state = {
        version: 1, identity: this.identity, collectionStartedAt: this.collectionStartedAt,
        lastSavedAt: savedAt, lastInstanceId: this.instanceId, lastSequence: this.sequence,
        previousUnfinished: this.totals.received - this.totals.completed,
        cleanShutdown: this.closed && this.totals.received === this.totals.completed,
        days: [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date)),
        gaps: this.gaps, omittedGaps: this.omittedGaps, faults: [...this.faults],
        greatestObservedAt: this.greatestObservedAt,
      };
      const serialized = JSON.stringify(state) + "\n";
      if (Buffer.byteLength(serialized) > this.maxStateBytes) { this.faults.add("state_over_budget"); throw new Error("aggregate over budget"); }
      this.assertWriter();
      atomicWriteText(this.file, serialized, 0o600);
      this.retainedBytes = Buffer.byteLength(serialized);
      this.lastSavedAt = savedAt; this.lastSavedSequence = this.sequence; this.savedRevision = this.revision;
      this.flushCount++;
    } catch { this.persistenceFailures++; this.faults.add("persistence_failed"); }
    finally {
      this.lastFlushMs = Math.max(0, this.monotonicNow() - start);
      this.maxFlushMs = Math.max(this.maxFlushMs, this.lastFlushMs);
    }
  }

  snapshot(options: { sampleOffset?: number; sampleLimit?: number } = {}) {
    const observedAt = new Date(this.time()).toISOString();
    const offset = bounded(options.sampleOffset, 0, 0, this.samples.length);
    const limit = bounded(options.sampleLimit, this.sampleLimit, 0, 256);
    const cutoff = this.cutoff();
    const days = [...this.days.values()].filter(day => day.date >= cutoff).sort((a, b) => a.date.localeCompare(b.date));
    const relevantGaps = this.gaps.filter(gap => gap.to.slice(0, 10) >= cutoff);
    return structuredClone({
      version: 1 as const, observedAt, counterScope: "current_process" as const,
      instanceId: this.instanceId, identity: this.identity, processStartedAt: this.processStartedAt,
      sequence: this.sequence, totals: { ...this.totals, inFlight: this.totals.received - this.totals.completed },
      sources: this.sources, series: [...this.series.values()], seriesOverflowRequests: this.seriesOverflowRequests,
      malformedCorrelations: this.malformedCorrelations, duplicateCompletions: this.duplicateCompletions,
      samples: this.samples.slice(offset, offset + limit),
      samplePage: { offset, limit, total: this.samples.length, nextOffset: limit > 0 && offset + limit < this.samples.length ? offset + limit : null },
      sampleCoverage: {
        retained: this.samples.length, omitted: this.totals.received - this.samples.length, limit: this.sampleLimit,
        semantics: "Last received requests in this process. Stable eventId deduplicates delivery; revision replaces an earlier sample. Totals are independent of samples.",
      },
      history: {
        scope: "retained_utc_arrival_days" as const,
        timezone: "UTC", retentionDays: this.retentionDays, collectionStartedAt: this.collectionStartedAt,
        startDate: cutoff, endDate: new Date(this.greatestObservedAt).toISOString().slice(0, 10),
        days, gaps: relevantGaps, omittedGaps: this.omittedGaps,
        partial: this.persistenceDisabled || this.faults.size > 0 || relevantGaps.length > 0 || this.omittedGaps > 0,
        legacyCoverageUnknown: true, startsOutsideRetention: this.startsOutsideRetention,
        lateCompletionsOutsideRetention: this.lateCompletionsOutsideRetention,
        unsupportedDimensions: ["daily_route", "execution_outcome", "effect_verification", "client_acceptance"],
        semantics: "UTC request-arrival cohorts; a completion updates its arrival day while retained. Received minus completed is missing completion evidence, not proof of a running operation. Restart intervals and unflushed tails are not reconstructed.",
      },
      coverage: {
        processCountsComplete: !this.faults.has("counter_saturated"),
        scope: "Requests admitted to agent HTTP hooks; not TCP attempts, workload success, or original caller identity. Shared bearer proves credential possession only.",
        persistence: !this.file ? "memory_only" : this.persistenceDisabled ? "unavailable" : this.savedRevision === this.revision ? "confirmed" : "pending",
        persistenceScope: "daily_aggregates" as const,
        writerProtection: this.file ? "exclusive_claim_no_automatic_takeover" : "not_configured",
        writerRecovery: "An existing claim may be live or orphaned. Retained history stays readable and current requests stay in memory. Publication requires inspected ownership; claims are never reclaimed automatically.",
        persistenceFailures: this.persistenceFailures, faults: [...this.faults], lastSavedAt: this.lastSavedAt,
        lastSavedSequence: this.lastSavedSequence, pendingChanges: this.revision - this.savedRevision,
        flushIntervalMs: this.flushIntervalMs,
        unflushedWindow: "Best-effort debounce interval; storage failure or event-loop stalls can extend it. Abrupt restart may lose an unknown tail.",
        flushCount: this.flushCount, lastFlushMs: this.lastFlushMs, maxFlushMs: this.maxFlushMs,
        retainedBytes: this.retainedBytes, maxStateBytes: this.maxStateBytes, maxSeries: this.maxSeries,
        knownRoutes: this.knownRoutes.size, routeLimit: 256,
        durability: process.platform === "win32" ? "file_sync_only" : "file_and_directory_sync",
        repairRequired: this.persistenceDisabled,
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.totals.received !== this.totals.completed) this.faults.add("closed_with_inflight");
    this.changed();
    this.flush();
    this.releaseWriter();
  }
}
