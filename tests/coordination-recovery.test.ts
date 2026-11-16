import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCoordinator, CoordinationError, coordinationHash, coordinationToken, coordinationDevice, coordinationIdentity, coordinationPublicRecord, type ReconciliationJobEvidence } from "../apps/agent/src/coordination.ts";
import { z } from "zod";
import * as state from "../apps/agent/src/state.ts";
import * as resources from "../apps/agent/src/coordination-resource.ts";
import * as jobs from "../apps/agent/src/jobs.ts";
import * as systemd from "../apps/agent/src/job-systemd.ts";
import { registerCoordinationRoutes } from "../apps/agent/src/coordination-routes.ts";
import { coordinationJobEvidence } from "../apps/agent/src/coordinated-repo.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const fn of close.splice(0)) await fn(); });
function fixture() {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "recovery-"));
  let boot = "linux:11111111-1111-4111-8111-111111111111", now = Date.now();
  const resource = { device: coordinationDevice, identity: coordinationIdentity, canonicalKey: coordinationHash(randomUUID()), baseVersion: coordinationHash("before") };
  const coordinator = new ResourceCoordinator(root, 4, () => now, 0o600, () => boot);
  const record = coordinator.acquire(resource), token = coordinationToken(record);
  coordinator.begin(token, resource);
  const changed = { ...resource, baseVersion: coordinationHash("partial fetch") };
  const evidence: ReconciliationJobEvidence = { id: randomUUID(), device: resource.device, identity: resource.identity, state: "completed", containmentVerified: true,
    evidenceHash: coordinationHash("verified containment"), key: "synthetic-operation-key", fingerprint: coordinationHash("job-input") };
  return { root, coordinator, resource, changed, token, evidence,
    boot: () => { boot = "linux:22222222-2222-4222-8222-222222222222"; }, age: () => { now += 365 * 24 * 3600_000; },
    restart: () => new ResourceCoordinator(root, 4, () => now, 0o600, () => boot),
    bind: () => { coordinator.bindExecution(token, { kind: "repo_job", key: evidence.key!, fingerprint: evidence.fingerprint!, requestHash: coordinationHash("request") }); coordinator.attachJob(token, evidence.id); },
  };
}

it("reconciles partial effects with exact execution binding and archives the original bytes", () => {
  const f = fixture(); f.bind(); f.coordinator.settle(f.token, { uncertain: true });
  const before = readFileSync(path.join(f.root, f.token.resourceId + ".json"), "utf8");
  const result = f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence);
  expect(result).toMatchObject({ alreadyReconciled: false, noReplay: true, record: { state: "released", baseVersion: f.resource.baseVersion,
    resolution: { kind: "durable_job", outcome: "completed", observedBaseVersion: f.changed.baseVersion, effectVerification: "unverified" } } });
  const archive = JSON.parse(readFileSync(path.join(f.root, "reconciliations", readdirSync(path.join(f.root, "reconciliations"))[0]!), "utf8"));
  expect(archive.originalJournal).toBe(before);
  expect(coordinationPublicRecord(archive.original)).toEqual(JSON.parse(before));
  const next = f.coordinator.acquire(f.changed);
  const newerBase = { ...f.changed, baseVersion: coordinationHash("later external work") };
  expect(f.coordinator.reconciled(f.token, newerBase, f.changed.baseVersion)).toMatchObject({ alreadyReconciled: true, record: { generation: 1 } });
  expect(f.coordinator.inspect(f.changed).record).toEqual(next);
});

it.each([false, true])("reads a published disposition with its original or freshly observed base after later changes (new generation %s)", nextGeneration => {
  const f = fixture(); f.bind();
  const resolved = f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence);
  if (nextGeneration) f.coordinator.acquire(f.changed);
  const later = { ...f.changed, baseVersion: coordinationHash("later repository state") };
  const journal = path.join(f.root, f.token.resourceId + ".json");
  const archive = path.join(f.root, "reconciliations", readdirSync(path.join(f.root, "reconciliations"))[0]!);
  const before = [journal, archive].map(file => readFileSync(file, "utf8"));
  for (const expected of [f.changed.baseVersion, later.baseVersion]) {
    expect(f.restart().reconciled(f.token, later, expected)).toMatchObject({ alreadyReconciled: true, record: resolved.record });
  }
  expect(() => f.restart().reconciled(f.token, later, coordinationHash("unrelated base"))).toThrow("recovery_base_changed");
  expect(readFileSync(journal, "utf8")).toBe(before[0]);
  // Reconfirming durability may canonicalize JSON field order. The original
  // journal bytes and every archived value must remain exactly the same.
  expect(JSON.parse(readFileSync(archive, "utf8"))).toEqual(JSON.parse(before[1]!));
});

it("keeps recovery inspection record and metadata in one journal generation during a concurrent transition", () => {
  const f = fixture(); f.bind();
  const current = f.coordinator.current.bind(f.coordinator);
  vi.spyOn(f.coordinator, "current").mockImplementation(resource => {
    const original = current(resource);
    f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence);
    f.coordinator.acquire(f.changed);
    return original;
  });
  const inspection = f.coordinator.inspectRecovery(f.resource);
  expect(inspection.record).toMatchObject({ operationId: f.token.operationId, generation: 1, state: "active" });
  expect(inspection.recovery.execution).toMatchObject({ key: f.evidence.key });
  expect(inspection.recovery.resolution).toBeNull();
  vi.mocked(f.coordinator.current).mockRestore();
  expect(f.coordinator.inspect(f.changed).record?.generation).toBe(2);
});

it("keeps active and released disk journals and legacy wire records readable by the frozen v1 schema", () => {
  // This is the baseline strict schema, deliberately independent of the current
  // protocol export: optional new fields must never silently break rollback.
  const hash = z.string().regex(/^[a-f0-9]{64}$/);
  const baseline = z.object({ resourceId: hash, operationId: z.string().uuid(), generation: z.number().int().positive(), baseVersion: hash,
    version: z.literal(1), budgetSlot: z.number().int().min(0).max(3), device: hash, identity: hash, canonicalKey: hash,
    state: z.enum(["reserved", "active", "released", "uncertain"]), createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.number(),
    instanceId: z.string().uuid(), jobId: z.string().uuid().optional(), conflictReason: z.string().max(80).nullable(),
    overrides: z.array(z.object({ operationId: z.string().uuid(), previousOperationId: z.string().uuid(), at: z.string().datetime(), reason: z.enum(["abandoned_reservation", "owner_takeover"]) })).max(32),
  }).strict();
  const f = fixture(); f.bind();
  const file = path.join(f.root, f.token.resourceId + ".json"), active = readFileSync(file, "utf8");
  const executionFile = path.join(f.root, "executions", readdirSync(path.join(f.root, "executions"))[0]!);
  const execution = readFileSync(executionFile, "utf8");
  expect(baseline.parse(JSON.parse(active)).state).toBe("active");
  expect(baseline.parse(f.coordinator.inspect(f.resource).record).state).toBe("active");
  expect(baseline.parse(new CoordinationError("fixture", f.coordinator.current(f.resource)).toJSON().details.coordination).state).toBe("active");
  expect(f.coordinator.inspectRecovery(f.resource).recovery.execution).toBeDefined();
  f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence);
  expect(baseline.parse(JSON.parse(readFileSync(file, "utf8"))).state).toBe("released");
  expect(baseline.parse(f.coordinator.inspect(f.changed).record).state).toBe("released");
  expect(readFileSync(executionFile, "utf8")).toBe(execution);
  const archive = JSON.parse(readFileSync(path.join(f.root, "reconciliations", readdirSync(path.join(f.root, "reconciliations"))[0]!), "utf8"));
  expect(archive.originalJournal).toBe(active);
  expect(baseline.parse(JSON.parse(archive.originalJournal)).state).toBe("active");
  expect(f.coordinator.acquire(f.changed).generation).toBe(2);
});

it("accepts only the baseline timestamp refresh after an already published release without rewriting it", () => {
  const f = fixture(); f.bind();
  f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence);
  const journal = path.join(f.root, f.token.resourceId + ".json"), record = JSON.parse(readFileSync(journal, "utf8"));
  // Frozen v1 acquire saves this intermediate journal before reserving the next
  // generation. Simulate an interrupted rollback at that exact persisted state.
  record.updatedAt = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(journal, JSON.stringify(record) + "\n");
  const before = readFileSync(journal, "utf8"), write = vi.spyOn(state, "atomicWriteJson");
  const later = { ...f.changed, baseVersion: coordinationHash("later work") };
  expect(f.restart().reconciled(f.token, later, f.changed.baseVersion)).toMatchObject({ alreadyReconciled: true });
  expect(f.restart().inspectRecovery(later).recovery.resolution).not.toBeNull();
  expect(readFileSync(journal, "utf8")).toBe(before); expect(write).not.toHaveBeenCalled();
  record.conflictReason = "unexpected_change";
  writeFileSync(journal, JSON.stringify(record));
  expect(() => f.restart().inspectRecovery(later)).toThrow("state_invalid");
  writeFileSync(journal, before);
  expect(f.restart().acquire(later).generation).toBe(2);
});

it("legacy and recovery inspections do not settle jobs or change the fence", async () => {
  const f = fixture(), jobId = randomUUID(); f.coordinator.settle(f.token, { jobId });
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root); vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
  const proof = vi.spyOn(jobs, "jobCoordinationStatus").mockResolvedValue({ version: 1, id: jobId, device: coordinationDevice, identity: coordinationIdentity, state: "completed" });
  const app = Fastify(); registerCoordinationRoutes(app); close.push(() => app.close());
  for (const action of ["inspect", "inspect_recovery"]) {
    const result = await app.inject({ method: "POST", url: "/v1/coordination", payload: { action, resource: { kind: "repo", path: "synthetic" } } });
    expect(result.statusCode).toBe(200); expect(result.json().record.state).toBe("active");
    expect(result.json().record).not.toHaveProperty("execution"); expect(result.json().record).not.toHaveProperty("resolution");
  }
  expect(proof).not.toHaveBeenCalled();
  const acquired = await app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "acquire", resource: { kind: "repo", path: "synthetic" } } });
  expect(acquired.statusCode).toBe(200); expect(acquired.json().record.generation).toBe(2);
});

it("new recovery actions cannot release an uncontained legacy job through the old automatic reconciler", async () => {
  const f = fixture(), jobId = randomUUID(); f.coordinator.settle(f.token, { jobId });
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root); vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
  const proof = vi.spyOn(jobs, "jobCoordinationStatus").mockResolvedValue({ version: 1, id: jobId, device: coordinationDevice, identity: coordinationIdentity, state: "completed" });
  const app = Fastify(); registerCoordinationRoutes(app); close.push(() => app.close());
  const input = { resource: { kind: "repo", path: "synthetic" }, token: f.token, expectedCurrentBaseVersion: f.resource.baseVersion };
  const prepared = await app.inject({ method: "POST", url: "/v1/coordination", payload: { ...input, action: "prepare_recovery" } });
  expect(prepared.statusCode, prepared.body).toBe(200); expect(prepared.json().record.state).toBe("active");
  expect(proof).not.toHaveBeenCalled();
  const recovered = await app.inject({ method: "POST", url: "/v1/coordination", payload: { ...input, action: "reconcile", recoveryIntentId: prepared.json().recoveryIntent.id } });
  expect(recovered.statusCode, recovered.body).toBe(409); expect(recovered.body).toContain("quiescence_unverified");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("active");
});

it.each(["key", "fingerprint", "id", "device", "identity", "containment"])("rejects mismatched or insufficient %s evidence without release", field => {
  const f = fixture(); f.bind(); f.coordinator.settle(f.token, { uncertain: true });
  const evidence = { ...f.evidence };
  if (field === "containment") evidence.containmentVerified = false;
  else if (field === "id") evidence.id = randomUUID();
  else Object.assign(evidence, { [field]: coordinationHash("wrong") });
  expect(() => f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, evidence)).toThrow();
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("uncertain");
  expect(() => f.coordinator.acquire(f.changed)).toThrow("active_or_uncertain_writer");
});

it("requires current base CAS and preserves generation, identity and the slot fence", () => {
  const f = fixture(); f.bind();
  expect(() => f.coordinator.reconcileJob(f.token, f.changed, f.resource.baseVersion, f.evidence)).toThrow("recovery_base_changed");
  expect(() => f.coordinator.reconcileJob({ ...f.token, generation: 2 }, f.changed, f.changed.baseVersion, f.evidence)).toThrow("stale_writer");
  expect(() => f.coordinator.reconcileJob(f.token, { ...f.changed, identity: coordinationHash("other") }, f.changed.baseVersion, f.evidence)).toThrow("resource_or_identity_changed");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("active");
});

it("prepares an immutable legacy intent; age, unchanged base and agent restart do not prove quiescence", () => {
  const f = fixture(); f.coordinator.settle(f.token, { uncertain: true });
  const file = path.join(f.root, f.token.resourceId + ".json"), original = readFileSync(file, "utf8");
  const prepared = f.coordinator.prepareRecovery(f.token, f.changed, f.changed.baseVersion);
  expect(readFileSync(file, "utf8")).toBe(original);
  const saved = JSON.parse(readFileSync(path.join(f.root, "recovery-intents", prepared.recoveryIntent.id + ".json"), "utf8"));
  expect(saved.originalJournal).toBe(original); expect(saved.original).toEqual(JSON.parse(original));
  f.age();
  expect(f.restart().prepareRecovery(f.token, f.changed, f.changed.baseVersion).recoveryIntent).toEqual(prepared.recoveryIntent);
  expect(() => f.restart().reconcileRecovery(f.token, f.changed, f.changed.baseVersion, prepared.recoveryIntent.id)).toThrow("quiescence_unverified");
  f.boot();
  const result = f.restart().reconcileRecovery(f.token, f.changed, f.changed.baseVersion, prepared.recoveryIntent.id);
  expect(result.record.resolution).toMatchObject({ kind: "boot_transition", outcome: "unknown", effectVerification: "unverified", noReplay: true });
  expect(f.restart().reconcileRecovery(f.token, f.changed, f.changed.baseVersion, prepared.recoveryIntent.id)).toMatchObject({ alreadyReconciled: true });
});

it("a boot before preparation is insufficient and an altered original or stale current base is rejected", () => {
  const f = fixture(); f.coordinator.settle(f.token, { uncertain: true }); f.boot();
  const intent = f.coordinator.prepareRecovery(f.token, f.changed, f.changed.baseVersion).recoveryIntent;
  expect(() => f.coordinator.reconcileRecovery(f.token, f.changed, f.changed.baseVersion, intent.id)).toThrow("quiescence_unverified");
  expect(() => f.coordinator.reconcileRecovery(f.token, f.resource, f.changed.baseVersion, intent.id)).toThrow("recovery_base_changed");
  const file = path.join(f.root, f.token.resourceId + ".json");
  writeFileSync(file, readFileSync(file, "utf8") + "\n");
  expect(() => f.coordinator.reconcileRecovery(f.token, f.changed, f.changed.baseVersion, intent.id)).toThrow("recovery_intent_mismatch");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("uncertain");
});

it("accepts an explicitly observed new base after the prepared boot boundary without another reboot", () => {
  const f = fixture(); f.coordinator.settle(f.token, { uncertain: true });
  const intent = f.coordinator.prepareRecovery(f.token, f.resource, f.resource.baseVersion).recoveryIntent;
  f.boot();
  expect(() => f.coordinator.reconcileRecovery(f.token, f.changed, f.resource.baseVersion, intent.id)).toThrow("recovery_base_changed");
  const result = f.coordinator.reconcileRecovery(f.token, f.changed, f.changed.baseVersion, intent.id);
  expect(result.record.resolution).toMatchObject({ kind: "boot_transition", outcome: "unknown", preparedBaseVersion: f.resource.baseVersion, observedBaseVersion: f.changed.baseVersion });
  expect(result.record.baseVersion).toBe(f.token.baseVersion);
});

it("rejects a corrupt boot identity in an otherwise valid historical intent", () => {
  const f = fixture(); f.coordinator.settle(f.token, { uncertain: true });
  const intent = f.coordinator.prepareRecovery(f.token, f.resource, f.resource.baseVersion).recoveryIntent;
  const file = path.join(f.root, "recovery-intents", intent.id + ".json"), saved = JSON.parse(readFileSync(file, "utf8"));
  saved.intent.bootIdentity = "linux:33333333-3333-4333-8333-333333333333";
  writeFileSync(file, JSON.stringify(saved));
  expect(() => f.coordinator.reconcileRecovery(f.token, f.resource, f.resource.baseVersion, intent.id)).toThrow("recovery_intent_mismatch");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("uncertain");
});

it.each(["durable", "legacy"])("unconfirmed %s history publication never releases the writer and a retry finishes only the archived transition", mode => {
  const f = fixture();
  let intentId: string | undefined;
  if (mode === "durable") f.bind();
  else { f.coordinator.settle(f.token, { jobId: f.evidence.id }); intentId = f.coordinator.prepareRecovery(f.token, f.changed, f.changed.baseVersion).recoveryIntent.id; f.boot(); }
  const atomic = state.atomicWriteJson;
  const write = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
    atomic(file, value, mode);
    if (file.includes(path.sep + "reconciliations" + path.sep)) throw new Error("synthetic directory sync failure");
  });
  expect(() => mode === "durable" ? f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence)
    : f.coordinator.reconcileRecovery(f.token, f.changed, f.changed.baseVersion, intentId!)).toThrow("synthetic directory sync failure");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("active");
  expect(() => f.coordinator.settle(f.token, { uncertain: true })).toThrow("reconciliation_pending");
  expect(() => f.restart().reconciled(f.token, f.changed, f.changed.baseVersion, intentId)).toThrow("synthetic directory sync failure");
  expect(() => f.coordinator.acquire(f.changed)).toThrow("active_or_uncertain_writer");
  write.mockRestore();
  expect(f.restart().reconciled(f.token, f.changed, f.changed.baseVersion, intentId)).toMatchObject({ alreadyReconciled: true, record: { state: "released" } });
});

it.each(["base", "journal", "slot"])("an interrupted archive retry revalidates the current %s fence before release", field => {
  const f = fixture(); f.bind();
  const atomic = state.atomicWriteJson;
  const write = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
    atomic(file, value, mode);
    if (file.includes(path.sep + "reconciliations" + path.sep)) throw new Error("synthetic directory sync failure");
  });
  expect(() => f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence)).toThrow("synthetic directory sync failure");
  write.mockRestore();
  const journal = path.join(f.root, f.token.resourceId + ".json");
  const slot = path.join(f.root, readdirSync(f.root).find(x => x.startsWith("slot-"))!);
  const archive = path.join(f.root, "reconciliations", readdirSync(path.join(f.root, "reconciliations"))[0]!);
  if (field === "journal") writeFileSync(journal, readFileSync(journal, "utf8") + "\n");
  if (field === "slot") writeFileSync(slot, JSON.stringify({ resourceId: f.token.resourceId, operationId: randomUUID() }));
  const observed = field === "base" ? { ...f.changed, baseVersion: coordinationHash("subsequent external change") } : f.changed;
  const before = [journal, slot, archive].map(file => readFileSync(file, "utf8"));
  expect(() => f.restart().reconciled(f.token, observed, f.changed.baseVersion)).toThrow(
    field === "base" ? "recovery_base_changed" : field === "journal" ? "recovery_record_changed" : "budget_fence_changed");
  if (field === "base") expect(() => f.restart().reconciled(f.token, observed, observed.baseVersion)).toThrow("recovery_evidence_mismatch");
  expect(f.coordinator.inspect(observed).record?.state).toBe("active");
  expect([journal, slot, archive].map(file => readFileSync(file, "utf8"))).toEqual(before);
});

it.each(["missing", "different_operation"])("an archive with a %s current journal cannot claim a published release", mode => {
  const f = fixture(); f.bind();
  const atomic = state.atomicWriteJson;
  const write = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, permissions) => {
    atomic(file, value, permissions);
    if (file.includes(path.sep + "reconciliations" + path.sep)) throw new Error("synthetic directory sync failure");
  });
  expect(() => f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence)).toThrow("synthetic directory sync failure");
  write.mockRestore();
  const journal = path.join(f.root, f.token.resourceId + ".json");
  if (mode === "missing") unlinkSync(journal);
  else { const record = JSON.parse(readFileSync(journal, "utf8")); record.operationId = randomUUID(); writeFileSync(journal, JSON.stringify(record)); }
  const slot = path.join(f.root, readdirSync(f.root).find(x => x.startsWith("slot-"))!);
  const before = readFileSync(slot, "utf8");
  expect(() => f.restart().reconciled(f.token, f.changed, f.changed.baseVersion)).toThrow("recovery_record_changed");
  expect(readFileSync(slot, "utf8")).toBe(before);
});

it("a missing archive leaves uncertainty and never frees capacity", () => {
  const f = fixture(); f.bind(); f.coordinator.settle(f.token, { uncertain: true });
  const atomic = state.atomicWriteJson;
  vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => { if (file.includes(path.sep + "reconciliations" + path.sep)) throw new Error("synthetic disk full"); atomic(file, value, mode); });
  expect(() => f.coordinator.reconcileJob(f.token, f.changed, f.changed.baseVersion, f.evidence)).toThrow("synthetic disk full");
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("uncertain");
  expect(readdirSync(f.root).some(x => x.startsWith("slot-"))).toBe(true);
});

it("concurrent prepare and reconcile requests are idempotent and client termination claims are rejected", async () => {
  const f = fixture(); f.coordinator.settle(f.token, { uncertain: true });
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
  vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.changed);
  const app = Fastify(); registerCoordinationRoutes(app); close.push(() => app.close());
  const body = { resource: { kind: "repo", path: "synthetic" }, token: f.token, expectedCurrentBaseVersion: f.changed.baseVersion };
  const prepare = () => app.inject({ method: "POST", url: "/v1/coordination", payload: { ...body, action: "prepare_recovery" } });
  const prepared = await Promise.all([prepare(), prepare()]);
  expect(prepared.map(r => r.statusCode)).toEqual([200, 200]);
  expect(prepared[0]!.json().recoveryIntent).toEqual(prepared[1]!.json().recoveryIntent);
  const invalid = await app.inject({ method: "POST", url: "/v1/coordination", payload: { ...body, action: "reconcile", terminationVerified: true } });
  expect(invalid.statusCode).toBe(400);
  // Reconciliation after a real boot transition is covered in the coordinator
  // fixture above; HTTP cannot supply or override the host's boot identity.
  const id = prepared[0]!.json().recoveryIntent.id;
  const reconcile = () => app.inject({ method: "POST", url: "/v1/coordination", payload: { ...body, action: "reconcile", recoveryIntentId: id } });
  const blocked = await Promise.all([reconcile(), reconcile()]);
  expect(blocked.map(r => r.statusCode)).toEqual([409, 409]);
  expect(f.coordinator.inspect(f.changed).record?.state).toBe("uncertain");
});

it("a persistence failure before dispatch cannot start a job or fall back to Git", async () => {
  const f = fixture(); f.coordinator.settle(f.token);
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
  vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
  vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "synthetic" });
  const start = vi.spyOn(jobs, "jobStart"), fallback = vi.fn();
  const atomic = state.atomicWriteJson;
  vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
    if (typeof value === "object" && value !== null && "execution" in value) throw new Error("synthetic binding persistence failure");
    atomic(file, value, mode);
  });
  const app = Fastify(); const coordinate = registerCoordinationRoutes(app); close.push(() => app.close());
  app.post("/v1/repo/fetch", (request, reply) => coordinate("/v1/repo/fetch", request, reply, { path: f.root }, fallback));
  const result = await app.inject({ method: "POST", url: "/v1/repo/fetch", payload: {} });
  expect(result.statusCode).toBe(500); expect(start).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("released");
});

it.each([false, true])("rejects an over-budget request before execution and requires recovery only if fence release fails (%s)", releaseFails => {
  return (async () => {
    const f = fixture(); f.coordinator.settle(f.token);
    vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
    vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "synthetic" });
    const start = vi.spyOn(jobs, "jobStart"), bind = vi.spyOn(ResourceCoordinator.prototype, "bindExecution"), fallback = vi.fn();
    if (releaseFails) {
      const atomic = state.atomicWriteJson;
      vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
        if ((value as { state?: string }).state === "released") throw new Error("synthetic release persistence failure");
        atomic(file, value, mode);
      });
    }
    const app = Fastify(); const coordinate = registerCoordinationRoutes(app); close.push(() => app.close());
    app.post("/v1/repo/fetch", (request, reply) => coordinate("/v1/repo/fetch", request, reply,
      { path: f.root, refspecs: ["x".repeat(64 * 1024)] }, fallback));
    const result = await app.inject({ method: "POST", url: "/v1/repo/fetch", payload: {} }), body = result.json();
    expect(result.statusCode, result.body).toBe(500);
    expect(body).toMatchObject({ error: releaseFails ? "repository_execution_requires_recovery" : "repository_operation_failed",
      executionOutcome: "not_started", coordination: { state: releaseFails ? "active" : "released" }, recovery: { execution: null, resolution: null } });
    if (!releaseFails) { expect(body.message).toContain("before dispatch"); expect(body.message).not.toContain("recovery"); }
    expect(body).not.toHaveProperty("jobId"); expect(body).not.toHaveProperty("operationSucceeded");
    expect(start).not.toHaveBeenCalled(); expect(bind).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
    expect(readdirSync(f.root)).not.toContain("repo-operations");
    expect(f.coordinator.inspect(f.resource).record?.state).toBe(releaseFails ? "active" : "released");
  })();
});

it("does not infer non-execution from a missing job reply after admission was attempted", async () => {
  const f = fixture(); f.coordinator.settle(f.token);
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
  vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
  vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "synthetic" });
  const start = vi.spyOn(jobs, "jobStart").mockRejectedValue(new Error("synthetic missing admission reply")), fallback = vi.fn();
  const app = Fastify(); const coordinate = registerCoordinationRoutes(app); close.push(() => app.close());
  app.post("/v1/repo/fetch", (request, reply) => coordinate("/v1/repo/fetch", request, reply, { path: f.root }, fallback));
  const result = await app.inject({ method: "POST", url: "/v1/repo/fetch", payload: {} }), body = result.json();
  expect(result.statusCode, result.body).toBe(500);
  expect(body).toMatchObject({ error: "repository_execution_requires_recovery", executionOutcome: "uncertain", noReplay: true, coordination: { state: "uncertain" }, recovery: { execution: { kind: "repo_job" } } });
  expect(body).not.toHaveProperty("jobId"); expect(start).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
});

it("refuses a new execution before dispatch when its future reconciliation store is already full", async () => {
  const f = fixture(); f.coordinator.settle(f.token);
  const archives = path.join(f.root, "reconciliations"); mkdirSync(archives);
  for (let i = 0; i < 4096; i++) writeFileSync(path.join(archives, `synthetic-${i}.json`), "preserved synthetic evidence\n");
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
  vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.resource);
  vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "synthetic" });
  const start = vi.spyOn(jobs, "jobStart"), fallback = vi.fn();
  const app = Fastify(); const coordinate = registerCoordinationRoutes(app); close.push(() => app.close());
  app.post("/v1/repo/fetch", (request, reply) => coordinate("/v1/repo/fetch", request, reply, { path: f.root }, fallback));
  const result = await app.inject({ method: "POST", url: "/v1/repo/fetch", payload: {} });
  expect(result.statusCode, result.body).toBe(409); expect(result.body).toContain("recovery_retention_full");
  expect(start).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("released");
  expect(readdirSync(archives)).toHaveLength(4096);
  expect(readFileSync(path.join(archives, "synthetic-0.json"), "utf8")).toBe("preserved synthetic evidence\n");
});

it("terminal status, missing PID and partial containment do not authorize reconciliation", async () => {
  const id = randomUUID();
  vi.spyOn(jobs, "jobCoordinationStatus").mockResolvedValue({ version: 1, id, device: coordinationDevice, identity: coordinationIdentity, state: "completed" });
  await expect(coordinationJobEvidence(id)).rejects.toThrow("termination_unverified");
});

it("two successful concurrent reconciliations release the original writer only once", async () => {
  const f = fixture(); f.bind(); f.coordinator.settle(f.token, { uncertain: true });
  vi.stubEnv("RCMCP_COORDINATION_DIR", f.root);
  vi.spyOn(resources, "resolveCoordinationResource").mockResolvedValue(f.changed);
  const job = { id: f.evidence.id, command: "synthetic", cwd: null, pid: 123, state: "completed" as const, startedAt: new Date().toISOString(),
    stdoutPath: "synthetic", stderrPath: "synthetic", exitPath: "synthetic", device: coordinationDevice, identity: coordinationIdentity,
    processIdentity: "linux:11111111-1111-4111-8111-111111111111:123", systemdUnit: systemd.jobUnitName(f.evidence.id),
    systemdInvocation: "fixture-invocation", systemdCgroup: "/synthetic/" + systemd.jobUnitName(f.evidence.id), stdoutBytes: 0, stderrBytes: 0,
    trackedProcessCount: 0, timing: { observedAt: new Date().toISOString(), shellExitMarkerAt: null, shellExitMarkerMeaning: "synthetic", finishedAt: null,
      finishedAtMeaning: "synthetic", wholeJobExitAt: null, wholeJobExitPrecision: "unknown" } };
  vi.spyOn(jobs, "jobStartKeyStatus").mockResolvedValue({ state: "resolved", jobId: job.id, fingerprint: f.evidence.fingerprint!, job });
  vi.spyOn(jobs, "jobCoordinationStatus").mockResolvedValue(job);
  vi.spyOn(systemd, "inspectJobUnitForCleanup").mockResolvedValue({ state: "absent" });
  vi.spyOn(systemd, "jobCgroupEmpty").mockReturnValue(true);
  const app = Fastify(); registerCoordinationRoutes(app); close.push(() => app.close());
  const call = () => app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: { kind: "repo", path: "synthetic" },
    token: f.token, expectedCurrentBaseVersion: f.changed.baseVersion } });
  const results = await Promise.all([call(), call()]);
  expect(results.map(r => r.statusCode)).toEqual([200, 200]);
  expect(results.map(r => r.json().alreadyReconciled).sort()).toEqual([false, true]);
  expect(readdirSync(path.join(f.root, "reconciliations"))).toHaveLength(1);
  expect(f.coordinator.acquire(f.changed).generation).toBe(2);
  const inspect = vi.mocked(systemd.inspectJobUnitForCleanup), empty = vi.mocked(systemd.jobCgroupEmpty);
  inspect.mockResolvedValue({ state: "present", unit: { active: "active", sub: "exited", pid: job.pid, invocation: job.systemdInvocation, cgroup: "" } });
  expect(await coordinationJobEvidence(job.id)).toMatchObject({ containmentVerified: true });
  empty.mockReturnValue(false);
  await expect(coordinationJobEvidence(job.id)).rejects.toThrow("termination_unverified");
  empty.mockReturnValue(true);
  inspect.mockResolvedValue({ state: "present", unit: { active: "active", sub: "running", pid: job.pid, invocation: job.systemdInvocation, cgroup: "" } });
  await expect(coordinationJobEvidence(job.id)).rejects.toThrow("termination_unverified");
  inspect.mockResolvedValue({ state: "present", unit: { active: "active", sub: "exited", pid: job.pid, invocation: "different-invocation", cgroup: "" } });
  await expect(coordinationJobEvidence(job.id)).rejects.toThrow("termination_unverified");
});
