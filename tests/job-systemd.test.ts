import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as systemd from "../apps/agent/src/job-systemd.ts";
import { jobCancel, jobStart, jobStartKeyStatus, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";

afterEach(() => vi.restoreAllMocks());

describe("durable systemd admission contracts", () => {
  it("cleans the agent cgroup on stop without binding durable units to it", () => {
    const unit = readFileSync("deploy/systemd/remote-control-user-agent.user.service", "utf8");
    expect(unit).toMatch(/^KillMode=(control-group|mixed)$/m);
    expect(unit).not.toMatch(/^KillMode=process$/m);
    expect(unit).not.toContain("OOMPolicy=continue");
    const implementation = readFileSync("apps/agent/src/job-systemd.ts", "utf8");
    expect(implementation).not.toMatch(/(?:PartOf|BindsTo)=remote-control/);
  });

  it("does not advertise isolation when explicitly disabled", () => {
    expect(systemd.jobCgroupIsolation()).toMatchObject({ ready: false });
    expect(runtimeStatus().capabilities).not.toContain("job-cgroup-isolation-v1");
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
    expect(await jobCancel(job.id)).toMatchObject({ state: "running", recoveryReason: "systemd_cancel_identity_unverified" });
    expect(stop).not.toHaveBeenCalled();
    inspect.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect((await jobCancel(job.id)).state).toBe("running");
    expect(stop).not.toHaveBeenCalled();
    unit.invocation = "original";
    expect(await jobCancel(job.id)).toMatchObject({ state: "cancelling", terminationVerified: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(job.id);
  });
});
