import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, unlinkSync, symlinkSync, rmSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { ResourceCoordinator, coordinationToken } from "../apps/agent/src/coordination.ts";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
import { jobCgroupIsolation, releaseJobUnit } from "../apps/agent/src/job-systemd.ts";
import { jobCancel, jobRemove, jobStartKeyStatus, jobStatusAsync, jobOutput } from "../apps/agent/src/jobs.ts";
import { jobFollow } from "../apps/agent/src/job-follow.ts";
import { shellQuote } from "../apps/agent/src/shell-quote.ts";
import * as state from "../apps/agent/src/state.ts";
import * as jobModule from "../apps/agent/src/jobs.ts";
import * as systemd from "../apps/agent/src/job-systemd.ts";

process.env.RCMCP_JOB_CGROUP_ISOLATION = "1";
const containment = jobCgroupIsolation();
const jobs = new Set<string>(), close: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of close.splice(0)) await fn();
  for (const id of jobs) { await jobCancel(id).catch(() => undefined); await jobRemove(id, true).catch(() => undefined); await releaseJobUnit(id); }
  jobs.clear(); vi.unstubAllEnvs();
});
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } }).trim();
}
async function fixture(indexLock: boolean) {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "repo-job-"));
  const origin = path.join(root, "origin.git"), seed = path.join(root, "seed"), working = path.join(root, "working");
  git(root, ["init", "--bare", "-q", origin]); git(root, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]); git(seed, ["config", "user.name", "Synthetic"]);
  git(seed, ["config", "user.email", "fixture@users.noreply.github.com"]);
  writeFileSync(path.join(seed, "fixture.txt"), "before\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "synthetic before"]); git(seed, ["push", "-q", "origin", "main"]);
  git(root, ["clone", "-q", "-b", "main", origin, working]);
  git(working, ["config", "core.hooksPath", path.join(working, ".git", "hooks")]);
  git(working, ["config", "protocol.file.allow", "always"]);
  const beforeHead = git(working, ["rev-parse", "HEAD"]), beforeRemote = git(working, ["rev-parse", "origin/main"]);
  writeFileSync(path.join(seed, "fixture.txt"), "after\n"); git(seed, ["add", "."]); git(seed, ["commit", "-qm", "synthetic after"]); git(seed, ["push", "-q", "origin", "main"]);
  if (indexLock) writeFileSync(path.join(working, ".git", "index.lock"), "synthetic lock\n");
  const coordinationRoot = path.join(root, "coordination"); vi.stubEnv("RCMCP_COORDINATION_DIR", coordinationRoot);
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const resource = { kind: "repo" as const, path: working }, coordinator = new ResourceCoordinator(coordinationRoot);
  const snapshot = async () => {
    const observed = await resolveCoordinationResource(resource), record = coordinator.current(observed)!;
    if (record.jobId) jobs.add(record.jobId);
    if (record.execution) { const key = await jobStartKeyStatus(record.execution.key); if ("jobId" in key && key.jobId) jobs.add(key.jobId); }
    return { observed, record };
  };
  return { root, working, beforeHead, beforeRemote, app, resource, coordinator, coordinationRoot, snapshot };
}

describe.skipIf(!containment.ready)(`coordinated repository systemd integration (${containment.ready ? "available" : "SKIP: " + containment.reason})`, () => {
  it("revalidates the base in the admitted worker before any Git effect", async () => {
    const f = await fixture(false), admit = systemd.admitJobUnit;
    vi.spyOn(systemd, "admitJobUnit").mockImplementation(async (...args) => {
      writeFileSync(path.join(f.working, "fixture.txt"), "external edit during admission\n");
      return admit(...args);
    });
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
    await f.snapshot();
    expect(result.statusCode, result.body).toBe(500); expect(result.json().message).toContain("base changed before execution");
    expect(git(f.working, ["rev-parse", "origin/main"])).toBe(f.beforeRemote);
    expect(git(f.working, ["rev-parse", "HEAD"])).toBe(f.beforeHead);
    expect(readFileSync(path.join(f.working, "fixture.txt"), "utf8")).toBe("external edit during admission\n");
  }, 25_000);

  it("pins the canonical target when a caller symlink is retargeted during admission", async () => {
    const f = await fixture(false), alias = path.join(f.root, "alias"), other = path.join(f.root, "other");
    git(f.root, ["clone", "-q", f.working, other]);
    const otherHead = git(other, ["rev-parse", "HEAD"]); symlinkSync(f.working, alias, "dir");
    const admit = systemd.admitJobUnit;
    vi.spyOn(systemd, "admitJobUnit").mockImplementation(async (...args) => { unlinkSync(alias); symlinkSync(other, alias, "dir"); return admit(...args); });
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: alias, timeoutMs: 5000 } });
    const { record } = await f.snapshot();
    expect(result.statusCode, result.body).toBe(200);
    expect(git(f.working, ["rev-parse", "HEAD"])).not.toBe(f.beforeHead);
    expect(git(other, ["rev-parse", "HEAD"])).toBe(otherHead);
    const request = JSON.parse(readFileSync(path.join(f.coordinationRoot, "repo-operations", record.operationId, "request.json"), "utf8"));
    expect(request.input.path).toBe(f.working); expect(record.state).toBe("released");
  }, 25_000);

  it.each(["nonzero", "lost"])("keeps a published operation success distinct from %s execution evidence", async condition => {
    const f = await fixture(false), status = jobModule.jobCoordinationStatus;
    vi.spyOn(jobModule, "jobCoordinationStatus").mockImplementation(async id => {
      const result = await status(id);
      return "systemdUnit" in result ? { ...result, state: condition === "lost" ? "lost" : result.state, exitCode: condition === "lost" ? null : 17 } : result;
    });
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
    await f.snapshot();
    expect(result.statusCode, result.body).toBe(500);
    expect(result.json()).toMatchObject({ ok: false, operationSucceeded: true, resultPublication: "available",
      executionOutcome: condition === "lost" ? "uncertain" : "exit_nonzero", effectVerification: "unverified" });
    expect(git(f.working, ["rev-parse", "HEAD"])).not.toBe(f.beforeHead);
  }, 25_000);

  it("reports missing output separately from exit zero and still supports no-replay reconciliation", async () => {
    const f = await fixture(false), atomic = state.atomicWriteJson;
    vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
      atomic(file, value, mode);
      if (file.includes(path.sep + "reconciliations" + path.sep)) {
        const id = (value as { original: { operationId: string } }).original.operationId;
        rmSync(path.join(f.coordinationRoot, "repo-operations", id, "result.json"), { force: true });
      }
    });
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
    const { record, observed } = await f.snapshot();
    expect(result.statusCode, result.body).toBe(500);
    expect(result.json()).toMatchObject({ error: "repository_result_unavailable", resultPublication: "unavailable", executionOutcome: "exit_zero", noReplay: true });
    const recovered = await f.app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: f.resource,
      token: coordinationToken(record), expectedCurrentBaseVersion: observed.baseVersion } });
    expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().alreadyReconciled).toBe(true);
  }, 25_000);

  it("one durable job covers partial fetch, failed merge, terminal receipt and idempotent reconciliation", async () => {
    const f = await fixture(true);
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
    const { record, observed } = await f.snapshot();
    expect(result.statusCode, result.body).toBe(500);
    expect(result.json()).toMatchObject({ ok: false, recoveryMode: "durable_job", noReplay: true, executionOutcome: "exit_nonzero", effectVerification: "unverified" });
    expect(result.json().message).toContain("index.lock");
    expect(git(f.working, ["rev-parse", "HEAD"])).toBe(f.beforeHead);
    expect(git(f.working, ["rev-parse", "origin/main"])).not.toBe(f.beforeRemote);
    expect(git(f.working, ["rev-parse", "FETCH_HEAD"])).toBe(git(f.working, ["rev-parse", "origin/main"]));
    expect(record.state).toBe("released"); expect(observed.baseVersion).not.toBe(record.baseVersion);
    const key = await jobStartKeyStatus(record.execution!.key);
    expect(key).toMatchObject({ state: "resolved", fingerprint: record.execution!.fingerprint, jobId: record.jobId });
    expect(await jobStatusAsync(record.jobId!)).toMatchObject({ state: "completed", exitCode: 1 });
    expect(jobOutput({ id: record.jobId!, length: 1024 }).eof).toBe(true);
    expect(readdirSync(path.join(f.coordinationRoot, "repo-operations"))).toEqual([record.operationId]);
    const input = { action: "reconcile", resource: f.resource, token: coordinationToken(record), expectedCurrentBaseVersion: observed.baseVersion };
    const repeated = await Promise.all([f.app.inject({ method: "POST", url: "/v1/coordination", payload: input }), f.app.inject({ method: "POST", url: "/v1/coordination", payload: input })]);
    expect(repeated.map(r => r.statusCode)).toEqual([200, 200]);
    expect(repeated.every(r => r.json().alreadyReconciled === true)).toBe(true);
    expect(await jobStartKeyStatus(record.execution!.key)).toMatchObject({ jobId: record.jobId });
  }, 25_000);

  it("recovers after a lost settlement publication without re-executing the Git operation", async () => {
    const f = await fixture(true), atomic = state.atomicWriteJson;
    const failure = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
      if (file.includes(path.sep + "reconciliations" + path.sep)) throw new Error("synthetic publication interruption");
      atomic(file, value, mode);
    });
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
    const { record, observed } = await f.snapshot(); failure.mockRestore();
    expect(result.statusCode).toBe(500); expect(record.state).toBe("uncertain");
    expect(record.execution).toBeDefined(); expect(record.jobId).toBeDefined();
    const originalJob = record.jobId, remote = git(f.working, ["rev-parse", "origin/main"]);
    const restarted = Fastify(); registerExtraRoutes(restarted); close.push(() => restarted.close());
    const recovered = await restarted.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: f.resource,
      token: coordinationToken(record), expectedCurrentBaseVersion: observed.baseVersion } });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({ record: { state: "released" }, recovery: { resolution: { jobId: originalJob, effectVerification: "unverified" } }, noReplay: true });
    expect(git(f.working, ["rev-parse", "origin/main"])).toBe(remote);
    expect(await jobStartKeyStatus(record.execution!.key)).toMatchObject({ jobId: originalJob });
  }, 25_000);

  it.each(["before_journal", "after_journal", "slot_read"].flatMap(failurePoint => [false, true].map(unavailableRead => ({ failurePoint, unavailableRead }))))(
    "preserves the original HTTP receipt when release publication fails ($failurePoint, fallback read unavailable $unavailableRead)", async ({ failurePoint, unavailableRead }) => {
      const f = await fixture(false), atomic = state.atomicWriteJson, current = ResourceCoordinator.prototype.current;
      let archivePublished = false;
      let originalSlot: { file: string; bytes: string } | undefined;
      const failure = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
        const released = value as { state?: string; device: string; budgetSlot: number };
        const releaseJournal = archivePublished && path.dirname(file) === f.coordinationRoot && released.state === "released";
        if (releaseJournal && failurePoint === "before_journal") throw new Error("synthetic release journal failure");
        atomic(file, value, mode);
        if (file.includes(path.sep + "reconciliations" + path.sep)) archivePublished = true;
        if (releaseJournal && failurePoint === "after_journal") throw new Error("synthetic post-rename publication failure");
        if (releaseJournal && failurePoint === "slot_read") {
          const slot = path.join(f.coordinationRoot, `slot-${released.device}-${released.budgetSlot}.json`);
          originalSlot = { file: slot, bytes: readFileSync(slot, "utf8") };
          writeFileSync(slot, "synthetic unreadable slot");
        }
      });
      const reader = vi.spyOn(ResourceCoordinator.prototype, "current").mockImplementation(function(this: ResourceCoordinator, resource) {
        if (archivePublished && unavailableRead) throw new Error("synthetic recovery read failure");
        return current.call(this, resource);
      });
      const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 5000 } });
      failure.mockRestore(); reader.mockRestore();
      if (originalSlot) writeFileSync(originalSlot.file, originalSlot.bytes);
      const { record, observed } = await f.snapshot(), body = result.json();
      expect(archivePublished).toBe(true); expect(result.statusCode, result.body).toBe(failurePoint === "slot_read" ? 409 : 500);
      expect(body).toMatchObject({ error: failurePoint === "slot_read" ? "coordination_conflict" : "repository_execution_requires_recovery", noReplay: true, recoveryMode: "durable_job", effectVerification: "unverified",
        jobId: record.jobId, coordination: { ...coordinationToken(record), token: coordinationToken(record) }, recovery: { execution: record.execution } });
      const receiptState = failurePoint === "before_journal" || unavailableRead ? "active" : "released";
      expect(body.coordination.state).toBe(receiptState);
      if (receiptState === "active") expect(body.recovery.resolution).toBeNull();
      else expect(body.recovery.resolution.jobId).toBe(body.jobId);
      if (failurePoint === "slot_read") expect(body).toMatchObject({ code: "COORDINATION_CONFLICT", details: { reason: "budget_state_invalid", coordination: { state: receiptState } } });
      expect(body).toMatchObject({ operationSucceeded: true, executionOutcome: "exit_zero", resultPublication: "available" });
      expect(record.state).toBe(failurePoint === "before_journal" ? "active" : "released"); expect(git(f.working, ["rev-parse", "HEAD"])).not.toBe(f.beforeHead);
      expect(await jobStatusAsync(record.jobId!)).toMatchObject({ state: "completed", exitCode: 0 });
      const recovered = await f.app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: f.resource,
        token: body.coordination.token, expectedCurrentBaseVersion: observed.baseVersion } });
      expect(recovered.statusCode, recovered.body).toBe(200); expect(recovered.json().record.state).toBe("released");
      expect(recovered.json().recovery.resolution.jobId).toBe(body.jobId);
      expect(await jobStartKeyStatus(record.execution!.key)).toMatchObject({ jobId: body.jobId });
      expect(readdirSync(path.join(f.coordinationRoot, "repo-operations"))).toEqual([record.operationId]);
  }, 25_000);

  it("a detached hook descendant keeps the whole repository operation fenced until its cgroup is empty", async () => {
    const f = await fixture(false), release = path.join(f.root, "release-child"), ready = path.join(f.root, "child-ready");
    const child = `echo ready > ${shellQuote(ready)}; while [ ! -f ${shellQuote(release)} ]; do sleep 0.03; done`;
    const hook = path.join(f.working, ".git", "hooks", "post-merge");
    writeFileSync(hook, `#!/bin/sh\nsetsid env -i PATH=/usr/bin:/bin /bin/sh -c ${shellQuote(child)} </dev/null >/dev/null 2>&1 &\n`); chmodSync(hook, 0o700);
    const result = await f.app.inject({ method: "POST", url: "/v1/repo/pull", payload: { path: f.working, timeoutMs: 1000 } });
    const { record, observed } = await f.snapshot();
    expect(result.statusCode, result.body).toBe(202); expect(result.json()).toMatchObject({ executionPending: true, recoveryMode: "durable_job" });
    expect(readFileSync(ready, "utf8")).toContain("ready"); expect(record.state).toBe("active");
    const blocked = await f.app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: f.resource,
      token: coordinationToken(record), expectedCurrentBaseVersion: observed.baseVersion } });
    expect(blocked.statusCode).toBe(409); expect(blocked.body).toContain("execution_not_terminal");
    writeFileSync(release, "go\n");
    expect(await jobFollow({ id: record.jobId!, until: "complete", waitMs: 8000 })).toMatchObject({ state: "completed", exitCode: 0 });
    const current = await resolveCoordinationResource(f.resource);
    const recovered = await f.app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "reconcile", resource: f.resource,
      token: coordinationToken(record), expectedCurrentBaseVersion: current.baseVersion } });
    expect(recovered.statusCode, recovered.body).toBe(200);
  }, 25_000);
});
