import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { IngressObserver, type IngressObserverOptions, type IngressStart } from "../apps/agent/src/ingress-observer.ts";

const observers: IngressObserver[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const observer of observers.splice(0)) observer.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const value = await mkdtemp(path.join(os.tmpdir(), "rcmcp-ingress-"));
  directories.push(value); return value;
}
function observer(options: Partial<IngressObserverOptions> = {}) {
  const value = new IngressObserver({ identity: "owner", knownRoutes: ["/v1/fs/read", "/health", "/v1/jobs/:id"], ...options });
  observers.push(value); return value;
}
const direct: IngressStart = { route: "/v1/fs/read", method: "POST", entryPoint: "unattributed", authentication: "bearer_verified" };
const correlated = (): IngressStart => ({
  ...direct, entryPoint: "controller_claimed",
  correlation: { version: 1, controllerInstanceId: randomUUID(), dispatchId: randomUUID(), traceId: randomUUID() },
});
const dayTotal = (value: ReturnType<IngressObserver["snapshot"]>, field: "received" | "completed") =>
  value.history.days.reduce((sum, day) => sum + day[field], 0);

it("counts every ingress independently of trace sampling and bounded dimensions", () => {
  let monotonic = 0;
  const value = observer({ sampleLimit: 2, maxSeries: 1, monotonicNow: () => monotonic });
  const requests = [direct, correlated(), { ...direct, route: "/health", method: "GET", authentication: "not_verified" as const }];
  for (const input of requests) {
    const handle = value.begin(input);
    monotonic += 5;
    expect(value.finish(handle, { statusCode: input.route === "/health" ? 200 : 400 })).toBe(true);
    expect(value.finish(handle, { statusCode: 200 })).toBe(false);
  }
  const result = value.snapshot();
  expect(result.totals).toMatchObject({ received: 3, completed: 3, inFlight: 0, response: 3, totalDurationMs: 15 });
  expect(result.totals.statuses).toMatchObject({ success: 1, clientError: 2 });
  expect(result.sources.reduce((sum, row) => sum + row.received, 0)).toBe(3);
  expect(result.samples).toHaveLength(2);
  expect(result.sampleCoverage).toMatchObject({ omitted: 1, retained: 2 });
  expect(result.series).toHaveLength(1);
  expect(result.seriesOverflowRequests).toBe(2);
  expect(result.duplicateCompletions).toBe(3);
  expect(dayTotal(result, "received")).toBe(3);
  expect(result.history.days[0]?.sources.reduce((sum, row) => sum + row.received, 0)).toBe(3);
  expect(result.samples.map(row => row.sequence)).toEqual([2, 3]);
  expect(result.samples.map(row => row.eventId)).toEqual([value.instanceId + ":2", value.instanceId + ":3"]);
  expect(result.coverage.processCountsComplete).toBe(true);
});

it("preserves receipt identity while sampled completion replaces the earlier event", () => {
  const value = observer();
  const request = value.begin(correlated());
  const before = value.snapshot().samples[0]!;
  expect(before).toMatchObject({ eventId: request.eventId, revision: 1, phase: "received" });
  expect(value.snapshot().totals.inFlight).toBe(1);
  value.finish(request, { outcome: "disconnected" });
  const after = value.snapshot().samples[0]!;
  expect(after).toMatchObject({ eventId: before.eventId, revision: 2, phase: "finished", outcome: "disconnected" });
  expect(value.snapshot().totals).toMatchObject({ received: 1, completed: 1, disconnected: 1, response: 0, inFlight: 0 });
  expect(value.finish({ ...request }, { statusCode: 200 })).toBe(false); // A copied/forged handle is not a new event.
  const secondObserver = observer();
  expect(secondObserver.finish(request)).toBe(false);
});

it("allows correlation without an operation trace but never upgrades an unauthenticated label", () => {
  const value = observer();
  const noTrace = correlated();
  delete noTrace.correlation!.traceId;
  value.finish(value.begin(noTrace), { statusCode: 200 });
  const unauthenticated = { ...correlated(), authentication: "not_verified" as const };
  value.finish(value.begin(unauthenticated), { statusCode: 200 });
  const rejected = { ...correlated(), authentication: "rejected" as const };
  value.finish(value.begin(rejected), { statusCode: 401 });
  const samples = value.snapshot().samples;
  expect(samples[0]).toMatchObject({ entryPoint: "controller_claimed", authentication: "bearer_verified" });
  expect(samples[0]?.correlation).not.toHaveProperty("traceId");
  for (const sample of samples.slice(1)) {
    expect(sample.entryPoint).toBe("unattributed");
    expect(sample).not.toHaveProperty("correlation");
  }
  expect(value.snapshot().sources.filter(row => row.entryPoint === "controller_claimed").reduce((n, row) => n + row.received, 0)).toBe(1);
});

it("rejects malformed or extra correlation fields without blocking requests or retaining private strings", () => {
  const value = observer({ sampleLimit: 10 });
  const malformed = {
    ...correlated(), route: "/v1/jobs/PRIVATE_ROUTE_SENTINEL?access=PRIVATE_QUERY_SENTINEL", method: "PRIVATE_METHOD_SENTINEL",
    correlation: { ...correlated().correlation!, privateField: "PRIVATE_CORRELATION_SENTINEL" },
    command: "PRIVATE_COMMAND_SENTINEL", environment: { example: "PRIVATE_ENV_SENTINEL" },
  } as IngressStart;
  const handle = value.begin(malformed);
  value.finish(handle, { statusCode: 500 });
  expect(value.snapshot().malformedCorrelations).toBe(1);
  expect(value.snapshot().samples[0]).toMatchObject({ route: "other", method: "OTHER", entryPoint: "unattributed", correlationInvalid: true });
  expect(JSON.stringify(value.snapshot())).not.toContain("SENTINEL");
  value.begin({ ...direct, correlationInvalid: true });
  expect(value.snapshot().malformedCorrelations).toBe(2);
});

it("bounds route registration and protects internal observations from snapshot mutation", () => {
  const value = observer({ knownRoutes: [] });
  for (let i = 0; i < 256; i++) expect(value.addKnownRoute("/v1/test-" + i)).toBe(true);
  expect(value.addKnownRoute("/v1/extra")).toBe(false);
  expect(value.addKnownRoute("/v1/test-0")).toBe(true);
  expect(value.addKnownRoute("/bad?query")).toBe(false);
  value.finish(value.begin({ ...direct, route: "/v1/test-0" }), { statusCode: 200 });
  const result = value.snapshot();
  result.totals.received = 99;
  result.samples[0]!.route = "/changed";
  result.history.days[0]!.received = 99;
  expect(value.snapshot().totals.received).toBe(1);
  expect(value.snapshot().samples[0]?.route).toBe("/v1/test-0");
  expect(value.snapshot().history.days[0]?.received).toBe(1);
});

it("keeps UTC arrival cohorts over rollover and retains late completion evidence", () => {
  let now = Date.parse("2026-01-01T23:59:59.500Z");
  let monotonic = 0;
  const value = observer({ now: () => now, monotonicNow: () => monotonic });
  const request = value.begin(direct);
  now += 2000; monotonic += 2000;
  value.finish(request, { statusCode: 200 });
  value.finish(value.begin(correlated()), { statusCode: 204 });
  const days = value.snapshot().history.days;
  expect(days.map(day => day.date)).toEqual(["2026-01-01", "2026-01-02"]);
  expect(days[0]).toMatchObject({ received: 1, completed: 1, totalDurationMs: 2000 });
  expect(days[1]).toMatchObject({ received: 1, completed: 1, totalDurationMs: 0 });
  const veryLate = value.begin(direct);
  now += 91 * 86_400_000; monotonic += 91 * 86_400_000;
  value.finish(veryLate, { outcome: "timeout" });
  const result = value.snapshot();
  expect(result.history.days).toEqual([]);
  expect(result.history.lateCompletionsOutsideRetention).toBe(1);
  expect(result.totals).toMatchObject({ received: 3, completed: 3, timeout: 1 });
});

it("uses monotonic duration and exposes clock regression instead of creating an unbounded historical day", () => {
  let now = Date.parse("2026-05-01T00:00:00Z");
  let monotonic = 0;
  const value = observer({ now: () => now, monotonicNow: () => monotonic });
  const request = value.begin(direct);
  now -= 100 * 86_400_000; monotonic += 12;
  value.finish(request, { statusCode: 200 });
  value.finish(value.begin(direct), { statusCode: 200 });
  const result = value.snapshot();
  expect(result.coverage.faults).toContain("clock_regressed");
  expect(result.history.startsOutsideRetention).toBe(1);
  expect(result.history.days).toHaveLength(1);
  expect(result.totals.totalDurationMs).toBe(12);
});

it("persists bounded daily totals independently of recovery files and avoids double counting on restart", async () => {
  const root = await directory();
  const recovery = path.join(root, "unrelated-recovery.json");
  await writeFile(recovery, "synthetic recovery evidence");
  let now = Date.parse("2026-06-01T12:00:00Z");
  const first = observer({ stateDirectory: path.join(root, "aggregate"), now: () => now, sampleLimit: 0 });
  for (let i = 0; i < 7; i++) first.finish(first.begin(i % 2 ? direct : correlated()), { statusCode: 200 });
  first.close();
  const raw = await readFile(path.join(root, "aggregate/aggregate.json"), "utf8");
  const saved = JSON.parse(raw);
  expect(saved.cleanShutdown).toBe(true);
  expect(saved.days[0].received).toBe(7);
  await rm(recovery);
  now += 60_000;
  const second = observer({ stateDirectory: path.join(root, "aggregate"), now: () => now });
  expect(second.instanceId).not.toBe(first.instanceId);
  expect(second.snapshot().totals.received).toBe(0);
  expect(dayTotal(second.snapshot(), "received")).toBe(7);
  second.finish(second.begin(direct), { statusCode: 201 });
  second.flush();
  expect(dayTotal(second.snapshot(), "received")).toBe(8);
  expect(second.snapshot().coverage).toMatchObject({ persistence: "confirmed", pendingChanges: 0, lastSavedSequence: 1 });
  expect(second.snapshot().history.gaps[0]?.reason).toBe("clean_restart_interval");
  second.close();
  now += 60_000;
  const third = observer({ stateDirectory: path.join(root, "aggregate"), now: () => now });
  expect(dayTotal(third.snapshot(), "received")).toBe(8);
  expect(third.snapshot().samples).toEqual([]);
});

it("reports an unclean checkpoint and lost tail as unknown without inventing or replaying events", async () => {
  const root = await directory();
  let now = Date.parse("2026-06-02T12:00:00Z");
  const first = observer({ stateDirectory: root, now: () => now });
  first.finish(first.begin(direct), { statusCode: 200 });
  first.begin(direct);
  first.flush();
  const checkpoint = await readFile(path.join(root, "aggregate.json"), "utf8");
  expect(JSON.parse(checkpoint).cleanShutdown).toBe(false);
  first.finish(first.begin(correlated()), { statusCode: 200 }); // Unflushed tail will not survive.
  expect(first.snapshot().coverage.pendingChanges).toBeGreaterThan(0);
  first.close();
  await writeFile(path.join(root, "aggregate.json"), checkpoint); // Synthetic abrupt-restart checkpoint.
  now += 30_000;
  const second = observer({ stateDirectory: root, now: () => now });
  const result = second.snapshot();
  expect(dayTotal(result, "received")).toBe(2);
  expect(dayTotal(result, "completed")).toBe(1);
  expect(result.totals.inFlight).toBe(0); // Old incomplete observations are not current running work.
  expect(result.history.gaps).toContainEqual({
    reason: "unclean_restart", from: "2026-06-02T12:00:00.000Z",
    to: "2026-06-02T12:00:30.000Z", previousUnfinished: 1,
  });
  expect(result.history.partial).toBe(true);
});

it("preserves corrupt, oversized and identity-mismatched state instead of replacing evidence", async () => {
  for (const input of ["{invalid synthetic json", "x".repeat(65_537)]) {
    const root = await directory();
    const file = path.join(root, "aggregate.json");
    await writeFile(file, input);
    const value = observer({ stateDirectory: root, maxStateBytes: 65_536 });
    value.finish(value.begin(direct), { statusCode: 200 });
    value.close();
    expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true, processCountsComplete: true });
    expect(value.snapshot().coverage.faults).toContain("state_corrupt");
    expect(await readFile(file, "utf8")).toBe(input);
  }
  const root = await directory();
  const original = observer({ stateDirectory: root }); original.close();
  const raw = await readFile(path.join(root, "aggregate.json"), "utf8");
  const incompatible = observer({ stateDirectory: root, identity: "root" });
  incompatible.finish(incompatible.begin(direct), { statusCode: 200 }); incompatible.close();
  expect(incompatible.snapshot().coverage.faults).toContain("state_identity_mismatch");
  expect(await readFile(path.join(root, "aggregate.json"), "utf8")).toBe(raw);
});

it("continues counting on publication failure and reports the unsaved suffix and flush cost", async () => {
  const root = await directory();
  const destination = path.join(root, "aggregate");
  const value = observer({ stateDirectory: destination });
  await rename(destination, path.join(root, "preserved"));
  await writeFile(destination, "synthetic path collision");
  const request = value.begin(direct); value.finish(request, { statusCode: 200 }); value.flush();
  const failed = value.snapshot();
  expect(failed.totals).toMatchObject({ received: 1, completed: 1 });
  expect(failed.coverage).toMatchObject({ persistence: "pending", persistenceFailures: 1 });
  expect(failed.coverage.faults).toContain("persistence_failed");
  expect(failed.coverage.pendingChanges).toBeGreaterThan(0);
  expect(failed.coverage.lastFlushMs).toBeGreaterThanOrEqual(0);
  expect(await readFile(destination, "utf8")).toBe("synthetic path collision");
  await rm(destination);
  await rename(path.join(root, "preserved"), destination);
  value.flush();
  expect(value.snapshot().coverage).toMatchObject({ persistence: "confirmed", pendingChanges: 0, persistenceFailures: 1 });
  expect(JSON.parse(await readFile(path.join(destination, "aggregate.json"), "utf8")).days[0].received).toBe(1);
});

it("bounds 90-day history, source buckets, samples and dimensions over a long synthetic workload", async () => {
  const root = await directory();
  let now = Date.parse("2026-01-01T12:00:00Z");
  const value = observer({ stateDirectory: root, now: () => now, sampleLimit: 3, maxSeries: 2 });
  for (let day = 0; day < 120; day++) {
    for (let request = 0; request < 8; request++) {
      value.finish(value.begin(request % 2 ? direct : correlated()), { statusCode: request % 3 ? 200 : 500 });
    }
    if (day < 119) now += 86_400_000;
  }
  value.flush();
  const result = value.snapshot();
  expect(result.history.days).toHaveLength(90);
  expect(result.history.days[0]?.date).toBe("2026-01-31");
  expect(dayTotal(result, "received")).toBe(90 * 8);
  expect(result.totals.received).toBe(120 * 8);
  expect(result.samples).toHaveLength(3);
  expect(result.series).toHaveLength(2);
  expect(result.history.days.every(day => day.sources.length <= 6)).toBe(true);
  expect(result.coverage.retainedBytes).toBeLessThan(65_536);
  expect(result.history.unsupportedDimensions).toContain("execution_outcome");
  const page = value.snapshot({ sampleOffset: 1, sampleLimit: 1 });
  expect(page.samples).toHaveLength(1);
  expect(page.samplePage.nextOffset).toBe(2);
  expect(value.snapshot({ sampleOffset: 2, sampleLimit: 1 }).samplePage.nextOffset).toBeNull();
});

it("expires retained day views after idle time even without another ingress", () => {
  let now = Date.parse("2026-01-01T12:00:00Z");
  const value = observer({ now: () => now });
  value.finish(value.begin(direct), { statusCode: 200 });
  expect(value.snapshot().history.days).toHaveLength(1);
  now += 91 * 86_400_000;
  const result = value.snapshot();
  expect(result.history.days).toEqual([]);
  expect(result.history.endDate).toBe("2026-04-02");
  expect(result.totals.received).toBe(1);
});


const damagedTimes = [
  { name: "an unrepresentable greatest timestamp", damage: (state: any) => { state.greatestObservedAt = 1e100; } },
  { name: "an invalid UTC calendar day", damage: (state: any) => { state.days[0].date = "2026-02-30"; } },
  { name: "an arrival day beyond the greatest timestamp", damage: (state: any) => { state.days[0].date = "2026-06-03"; } },
  { name: "a saved timestamp beyond the greatest timestamp", damage: (state: any) => { state.lastSavedAt = "2026-06-03T12:00:00.000Z"; } },
  { name: "a collection timestamp beyond the greatest timestamp", damage: (state: any) => { state.collectionStartedAt = "2026-06-03T12:00:00.000Z"; } },
  { name: "a gap endpoint beyond the greatest timestamp", damage: (state: any) => {
    state.gaps = [{ reason: "clean_restart_interval", from: "2026-06-01T12:00:00.000Z",
      to: "2026-06-03T12:00:00.000Z", previousUnfinished: 0 }];
  } },
];
for (const { name, damage } of damagedTimes) it(`rejects ${name} before applying any restored state`, async () => {
  const root = await directory();
  const file = path.join(root, "aggregate.json");
  const seed = observer({ stateDirectory: root, now: () => Date.parse("2026-06-01T12:00:00Z") });
  seed.finish(seed.begin(direct), { statusCode: 200 }); seed.close();
  const damaged = JSON.parse(await readFile(file, "utf8"));
  damage(damaged);
  const raw = JSON.stringify(damaged) + "\n";
  await writeFile(file, raw);

  const value = observer({ stateDirectory: root, now: () => Date.parse("2026-06-02T12:00:00Z") });
  expect(() => value.finish(value.begin(direct), { statusCode: 201 })).not.toThrow();
  const result = value.snapshot();
  expect(result.totals).toMatchObject({ received: 1, completed: 1, inFlight: 0 });
  expect(result.history.collectionStartedAt).toBe("2026-06-02T12:00:00.000Z");
  expect(result.history.days).toHaveLength(1);
  expect(result.history.days[0]).toMatchObject({ date: "2026-06-02", received: 1, completed: 1 });
  expect(result.history.gaps).toEqual([]);
  expect(result.coverage).toMatchObject({ persistence: "unavailable", repairRequired: true, processCountsComplete: true, retainedBytes: 0 });
  expect(result.coverage.faults).toContain("state_corrupt");
  value.close();
  expect(await readFile(file, "utf8")).toBe(raw);
});

it.skipIf(process.platform === "win32")("rejects a FIFO state path without blocking startup or the workload", async () => {
  const root = await directory();
  const file = path.join(root, "aggregate.json");
  execFileSync("mkfifo", [file], { timeout: 1000 });
  const moduleUrl = new URL("../apps/agent/src/ingress-observer.ts", import.meta.url).href;
  const script = `
    import { IngressObserver } from ${JSON.stringify(moduleUrl)};
    const value = new IngressObserver({
      identity: "owner", stateDirectory: process.argv[1], knownRoutes: ["/v1/fs/read"],
    });
    value.finish(value.begin({
      route: "/v1/fs/read", method: "POST", entryPoint: "unattributed", authentication: "bearer_verified",
    }), { statusCode: 200 });
    value.close();
    process.stdout.write(JSON.stringify(value.snapshot()));
  `;
  // A blocked open must not trap the Vitest worker or leave a child behind.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, root], {
    encoding: "utf8", timeout: 3000, killSignal: "SIGKILL", maxBuffer: 65_536,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout);
  expect(result.totals).toMatchObject({ received: 1, completed: 1, inFlight: 0 });
  expect(result.coverage).toMatchObject({ persistence: "unavailable", repairRequired: true, processCountsComplete: true });
  expect(result.coverage.faults).toContain("state_corrupt");
  expect(fs.lstatSync(file).isFIFO()).toBe(true);
}, 5000);

it("contains a state-file close error and preserves the previous evidence", async () => {
  const root = await directory();
  const file = path.join(root, "aggregate.json");
  const seed = observer({ stateDirectory: root, now: () => Date.parse("2026-06-01T12:00:00Z") });
  seed.finish(seed.begin(direct), { statusCode: 200 }); seed.close();
  const raw = await readFile(file, "utf8");
  const originalClose = fs.closeSync;
  let closeCalls = 0;
  let value: IngressObserver | undefined;
  try {
    fs.closeSync = (fd: number) => {
      originalClose(fd); // Keep the synthetic fault from leaking a real descriptor.
      if (++closeCalls === 1) throw Object.assign(new Error("synthetic close failure"), { code: "EIO" });
    };
    syncBuiltinESMExports();
    expect(() => { value = observer({ stateDirectory: root, now: () => Date.parse("2026-06-02T12:00:00Z") }); }).not.toThrow();
  } finally {
    fs.closeSync = originalClose; syncBuiltinESMExports();
  }
  expect(closeCalls).toBe(1);
  value!.finish(value!.begin(direct), { statusCode: 200 }); value!.close();
  const result = value!.snapshot();
  expect(result.totals).toMatchObject({ received: 1, completed: 1, inFlight: 0 });
  expect(result.history.collectionStartedAt).toBe("2026-06-02T12:00:00.000Z");
  expect(result.history.days).toHaveLength(1);
  expect(result.history.days[0]).toMatchObject({ date: "2026-06-02", received: 1, completed: 1 });
  expect(result.coverage).toMatchObject({ persistence: "unavailable", repairRequired: true, processCountsComplete: true });
  expect(result.coverage.faults).toContain("state_unavailable");
  expect(await readFile(file, "utf8")).toBe(raw);
});


it("restores a real leap day and reversed clock gaps without rejecting valid history", async () => {
  const root = await directory();
  let now = Date.parse("2028-02-29T23:00:00Z");
  const first = observer({ stateDirectory: root, now: () => now });
  first.finish(first.begin(direct), { statusCode: 200 }); first.close();
  now -= 86_400_000;
  const second = observer({ stateDirectory: root, now: () => now });
  second.finish(second.begin(direct), { statusCode: 201 }); second.close();
  const third = observer({ stateDirectory: root, now: () => now });
  const result = third.snapshot();
  expect(dayTotal(result, "received")).toBe(2);
  expect(result.history.collectionStartedAt).toBe("2028-02-29T23:00:00.000Z");
  expect(result.history.days.map(day => day.date)).toEqual(["2028-02-28", "2028-02-29"]);
  expect(result.history.gaps).toContainEqual({
    reason: "clean_restart_interval", from: "2028-02-29T23:00:00.000Z",
    to: "2028-02-28T23:00:00.000Z", previousUnfinished: 0,
  });
  expect(result.coverage).toMatchObject({ persistence: "confirmed", repairRequired: false });
  expect(result.coverage.faults).toContain("clock_regressed");
  expect(result.coverage.faults).not.toContain("state_corrupt");
});
