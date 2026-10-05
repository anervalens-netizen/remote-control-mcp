import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as systemd from "../apps/agent/src/job-systemd.ts";
import { jobCancel, jobHistoryPage, jobStart, jobStartKeyStatus, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";

afterEach(() => vi.restoreAllMocks());

describe("durable systemd admission contracts", () => {
  it("cleans the agent cgroup on stop without binding durable units to it", () => {
    for (const file of ["deploy/systemd/remote-control-user-agent.user.service", "deploy/systemd/remote-control-agent.user.service", "deploy/systemd/install-root-agent.sh"]) {
      const unit = readFileSync(file, "utf8");
      expect(unit).toMatch(/KillMode=(control-group|mixed)/);
      expect(unit).not.toMatch(/KillMode=process/);
      expect(unit).not.toContain("OOMPolicy=continue");
    }
    const implementation = readFileSync("apps/agent/src/job-systemd.ts", "utf8");
    expect(implementation).not.toMatch(/(?:PartOf|BindsTo)=remote-control/);
    expect(implementation).toContain('"--collect", "--unit", jobUnitName(id)');
  });

  it("does not advertise isolation when explicitly disabled", () => {
    expect(systemd.jobCgroupIsolation()).toMatchObject({ ready: false });
    expect(runtimeStatus().capabilities).not.toContain("job-cgroup-isolation-v1");
  });

  it("uses the system manager for root and the user manager for owner agents", () => {
    expect(systemd.jobSystemdManagerScope(0, "linux")).toBe("system");
    expect(systemd.jobSystemdManagerScope(1000, "linux")).toBe("user");
    expect(systemd.jobSystemdManagerScope(65534, "linux")).toBe("user");
    expect(systemd.jobSystemdManagerScope(null, "win32")).toBe("unsupported");
  });

  it("accepts only exact UUID-derived job units", () => {
    expect(systemd.jobUnitName("11111111-1111-4111-8111-111111111111")).toBe("rcmcp-job-11111111-1111-4111-8111-111111111111.service");
    for (const id of ["remote-control-user-agent", "../other", "secret=value", "--all"]) expect(() => systemd.jobUnitName(id)).toThrow();
  });

  it("preserves evidence and never executes via fallback after pre-effect admission failure", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    const admission = vi.spyOn(systemd, "admitJobUnit").mockRejectedValue(new Error("synthetic secret must stay private"));
    vi.spyOn(systemd, "inspectJobUnit").mockReturnValue(null);
    const inspectAsync = vi.spyOn(systemd, "inspectJobUnitAsync").mockResolvedValue(null);
    const effect = path.join(process.env.RCMCP_STATE_DIR!, "must-not-exist");
    const input = { command: `echo effect > '${effect}'`, idempotencyKey: "admission-rejected" };
    await expect(jobStart(input)).rejects.toMatchObject({ code: "job_start_uncertain" });
    expect(existsSync(effect)).toBe(false);
    const retry = await jobStart(input);
    expect(retry).toMatchObject({ state: "running", pid: 0, recoveryReason: "systemd_unit_lookup_uncertain" });
    expect(admission).toHaveBeenCalledTimes(1);
    expect(inspectAsync).toHaveBeenCalledWith(retry.id);
    expect(await jobStartKeyStatus(input.idempotencyKey)).toMatchObject({ state: "resolved", jobId: retry.id });
    expect(existsSync(path.join(process.env.RCMCP_STATE_DIR!, "jobs", retry.id + ".launch"))).toBe(true);
  });

  it("inspects the reservation after uncertain effectful admission and never duplicates effects", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    vi.spyOn(systemd, "inspectJobUnit").mockReturnValue(null);
    vi.spyOn(systemd, "inspectJobUnitAsync").mockResolvedValue(null);
    let effects = 0;
    vi.spyOn(systemd, "admitJobUnit").mockImplementation(async () => { effects++; throw new Error("lost admission reply"); });
    const input = { command: "synthetic effect", idempotencyKey: "admission-reply-lost" };
    await expect(jobStart(input)).rejects.toMatchObject({ code: "job_start_uncertain" });
    const retry = await jobStart(input);
    await jobStart(input);
    expect(effects).toBe(1);
    expect(retry.recoveryReason).toBe("systemd_unit_lookup_uncertain");
    // A marker without a launch/cgroup receipt does not authorize completion.
    writeFileSync(retry.exitPath, "0\n");
    expect((await jobStatusAsync(retry.id)).state).toBe("running");
    await expect(jobStart({ ...input, command: "different input" })).rejects.toMatchObject({ code: "job_start_conflict" });
  });

  it("refuses cancellation for replaced units and never verifies a still-populated cgroup", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    vi.spyOn(systemd, "admitJobUnit").mockResolvedValue();
    const unit = { active: "active", sub: "running", pid: 12345, invocation: "original", cgroup: "" };
    const inspect = vi.spyOn(systemd, "inspectJobUnitAsync").mockImplementation(async id => ({ ...unit, cgroup: "/synthetic/" + systemd.jobUnitName(id) }));
    vi.spyOn(systemd, "jobCgroupEmpty").mockReturnValue(false);
    const stop = vi.spyOn(systemd, "stopJobUnit").mockResolvedValue(true);
    const job = await jobStart({ command: "synthetic never executed", idempotencyKey: "cancel-binding" });
    unit.invocation = "replacement";
    expect(await jobCancel(job.id)).toMatchObject({ state: "running", recoveryReason: "systemd_unit_identity_mismatch" });
    expect(stop).not.toHaveBeenCalled();
    inspect.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect((await jobCancel(job.id)).state).toBe("running");
    expect(stop).not.toHaveBeenCalled();
    unit.invocation = "original";
    expect(await jobCancel(job.id)).toMatchObject({ state: "cancelling", terminationVerified: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(job.id);
  });

  it("reconciles a timed-out stop only after the same identity-bound cgroup becomes empty", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    vi.spyOn(systemd, "admitJobUnit").mockResolvedValue();
    const unit = { active: "active", sub: "running", pid: 23456, invocation: "cancel-later", cgroup: "" };
    vi.spyOn(systemd, "inspectJobUnitAsync").mockImplementation(async id => ({ ...unit, cgroup: "/synthetic/" + systemd.jobUnitName(id) }));
    let empty = false;
    vi.spyOn(systemd, "jobCgroupEmpty").mockImplementation(() => empty);
    vi.spyOn(systemd, "stopJobUnit").mockResolvedValue(false);
    const job = await jobStart({ command: "synthetic never executed", idempotencyKey: "cancel-timeout-later-empty" });
    expect(await jobCancel(job.id)).toMatchObject({ state: "cancelling", terminationVerified: false });
    expect((await jobStatusAsync(job.id)).state).toBe("cancelling");
    empty = true;
    const restartedInspect = vi.fn(async () => ({ state: "absent" as const }));
    const restartedCollect = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock("../apps/agent/src/job-systemd.ts", async () => ({
      ...(await vi.importActual<typeof systemd>("../apps/agent/src/job-systemd.ts")),
      inspectJobUnitAsync: async () => ({ ...unit, cgroup: "/synthetic/" + systemd.jobUnitName(job.id) }),
      inspectJobUnitForCleanup: restartedInspect,
      jobCgroupEmpty: () => true,
      releaseJobUnit: restartedCollect,
    }));
    try {
      const restarted = await import("../apps/agent/src/jobs.ts");
      expect(await restarted.jobStatusAsync(job.id)).toMatchObject({ state: "cancelled", terminationVerified: true,
        terminationVerification: "identity_bound_job", terminationVerificationScope: "whole_tree" });
      await vi.waitFor(() => expect(restartedInspect).toHaveBeenCalledWith(job.id));
      expect(restartedCollect).not.toHaveBeenCalled();
    } finally { vi.doUnmock("../apps/agent/src/job-systemd.ts"); }
    for (const file of [job.stdoutPath, job.stderrPath, path.join(process.env.RCMCP_STATE_DIR!, "jobs", job.id + ".json"), path.join(process.env.RCMCP_STATE_DIR!, "jobs", job.id + ".launch")]) {
      expect(existsSync(file)).toBe(true);
    }
  });

  it("keeps populated or identity-mismatched systemd cancellations non-terminal", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    vi.spyOn(systemd, "admitJobUnit").mockResolvedValue();
    const unit = { active: "active", sub: "running", pid: 34567, invocation: "original-cancel", cgroup: "" };
    const inspect = vi.spyOn(systemd, "inspectJobUnitAsync").mockImplementation(async id => ({ ...unit, cgroup: "/synthetic/" + systemd.jobUnitName(id) }));
    let empty = false;
    vi.spyOn(systemd, "jobCgroupEmpty").mockImplementation(() => empty);
    vi.spyOn(systemd, "stopJobUnit").mockResolvedValue(false);
    const job = await jobStart({ command: "synthetic never executed", idempotencyKey: "cancel-populated-or-mismatch" });
    expect((await jobCancel(job.id)).state).toBe("cancelling");
    expect((await jobStatusAsync(job.id)).state).toBe("cancelling");
    empty = true; unit.invocation = "replacement";
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "cancelling", recoveryReason: "systemd_unit_identity_mismatch" });
    expect(await jobCancel(job.id)).toMatchObject({ state: "cancelling", recoveryReason: "systemd_unit_identity_mismatch", terminationVerified: false });
    inspect.mockResolvedValue(null);
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "cancelling", recoveryReason: "systemd_unit_identity_mismatch" });
  });

  it("reinspects a queued terminal unit before cleanup and never stops a replacement", async () => {
    const jobsRoot = path.join(process.env.RCMCP_STATE_DIR!, "jobs");
    const ids: string[] = Array.from({ length: 5 }, () => randomUUID());
    const invocations = new Map(ids.map(id => [id, "original-" + id]));
    vi.spyOn(systemd, "inspectJobUnitAsync").mockImplementation(async id => ({
      active: "active", sub: "exited", pid: 45678, invocation: invocations.get(id)!, cgroup: "/synthetic/" + systemd.jobUnitName(id),
    }));
    vi.spyOn(systemd, "jobCgroupEmpty").mockReturnValue(true);
    const inspectionCounts = new Map<string, number>();
    vi.spyOn(systemd, "inspectJobUnitForCleanup").mockImplementation(async id => {
      const count = (inspectionCounts.get(id) ?? 0) + 1; inspectionCounts.set(id, count);
      if (count > 1 && ids.slice(0, 4).includes(id)) return { state: "absent" };
      return { state: "present", unit: {
        active: "active", sub: "exited", pid: 45678, invocation: invocations.get(id)!, cgroup: "/synthetic/" + systemd.jobUnitName(id),
      } };
    });
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const releases: string[] = [];
    vi.spyOn(systemd, "releaseJobUnit").mockImplementation(async id => {
      releases.push(id);
      if (ids.slice(0, 4).includes(id)) await blocked;
    });
    for (const id of ids) {
      const startedAt = new Date().toISOString();
      writeFileSync(path.join(jobsRoot, id + ".json"), JSON.stringify({
        id, command: "synthetic terminal fixture", cwd: null, pid: 45678, state: "running", startedAt,
        stdoutPath: path.join(jobsRoot, id + ".stdout.log"), stderrPath: path.join(jobsRoot, id + ".stderr.log"),
        exitPath: path.join(jobsRoot, id + ".exit"), systemdUnit: systemd.jobUnitName(id), systemdInvocation: invocations.get(id),
        systemdCgroup: "/synthetic/" + systemd.jobUnitName(id),
      }));
      writeFileSync(path.join(jobsRoot, id + ".exit"), "0\n");
      expect(await jobStatusAsync(id)).toMatchObject({ state: "completed", exitCode: 0 });
    }
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    invocations.set(ids[4]!, "replacement-" + ids[4]);
    unblock();
    await vi.waitFor(() => expect(inspectionCounts.get(ids[4]!)).toBe(1));
    expect(releases).not.toContain(ids[4]);
  });

  it("collects a matching completed transient unit while retaining durable evidence", async () => {
    vi.spyOn(systemd, "jobCgroupIsolation").mockReturnValue({ ready: true, reason: "fixture" });
    vi.spyOn(systemd, "admitJobUnit").mockResolvedValue();
    const unit = { active: "active", sub: "exited", pid: 45678, invocation: "completed-unit", cgroup: "" };
    vi.spyOn(systemd, "inspectJobUnitAsync").mockImplementation(async id => ({ ...unit, cgroup: "/synthetic/" + systemd.jobUnitName(id) }));
    vi.spyOn(systemd, "jobCgroupEmpty").mockReturnValueOnce(false).mockReturnValue(true);
    vi.spyOn(systemd, "inspectJobUnitForCleanup")
      .mockResolvedValueOnce({ state: "present", unit })
      .mockResolvedValueOnce({ state: "present", unit })
      .mockResolvedValue({ state: "absent" });
    const collect = vi.spyOn(systemd, "releaseJobUnit")
      .mockRejectedValueOnce(new Error("synthetic cleanup failure"))
      .mockResolvedValue();
    const job = await jobStart({ command: "synthetic never executed", idempotencyKey: "terminal-unit-collection" });
    writeFileSync(job.exitPath, "0\n");
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "completed", exitCode: 0 });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledWith(job.id));
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "completed", exitCode: 0 });
    expect(collect).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 1050));
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "completed", exitCode: 0 });
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
    expect(readFileSync(job.exitPath, "utf8")).toBe("0\n");
    expect(existsSync(path.join(process.env.RCMCP_STATE_DIR!, "jobs", job.id + ".json"))).toBe(true);
    expect(existsSync(job.stdoutPath)).toBe(true); expect(existsSync(job.stderrPath)).toBe(true);
  });

  it("bounds and deduplicates cleanup for more than one hundred terminal history entries", async () => {
    const jobsRoot = path.join(process.env.RCMCP_STATE_DIR!, "jobs");
    const ids = new Set<string>();
    const calls = new Map<string, number>();
    let active = 0, peak = 0, completed = 0;
    const inspect = vi.spyOn(systemd, "inspectJobUnitForCleanup").mockImplementation(async id => {
      if (!ids.has(id)) return { state: "absent" };
      calls.set(id, (calls.get(id) ?? 0) + 1);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--; completed++;
      return { state: "absent" };
    });
    const release = vi.spyOn(systemd, "releaseJobUnit").mockResolvedValue();
    for (let index = 0; index < 120; index++) {
      const id = randomUUID(), startedAt = new Date(Date.now() - index).toISOString();
      ids.add(id);
      writeFileSync(path.join(jobsRoot, id + ".json"), JSON.stringify({
        id, command: "synthetic terminal fixture", cwd: null, pid: 0, state: "completed", startedAt, finishedAt: startedAt,
        stdoutPath: path.join(jobsRoot, id + ".stdout.log"), stderrPath: path.join(jobsRoot, id + ".stderr.log"),
        exitPath: path.join(jobsRoot, id + ".exit"), systemdUnit: systemd.jobUnitName(id), systemdInvocation: "invocation-" + id,
      }));
    }
    const first = await jobHistoryPage({ limit: 1000 });
    expect(first.items.filter(item => ids.has(item.id))).toHaveLength(120);
    await vi.waitFor(() => expect(completed).toBe(120));
    expect(peak).toBeLessThanOrEqual(4);
    expect(calls.size).toBe(120);
    expect([...calls.values()].every(count => count === 1)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    await jobHistoryPage({ limit: 1000 });
    await Promise.all([...ids].slice(0, 12).map(id => jobStatusAsync(id)));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(inspect.mock.calls.filter(([id]) => ids.has(id))).toHaveLength(120);
  });
});
