import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as systemd from "../apps/agent/src/job-systemd.ts";
import { jobCgroupEmpty, jobCgroupIsolation, inspectJobUnit, releaseJobUnit } from "../apps/agent/src/job-systemd.ts";
import { jobCancel, jobHistoryPage, jobOutput, jobRemove, jobStart, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { currentProcessIdentity } from "../apps/agent/src/process-identity.ts";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";
import { jobFollow } from "../apps/agent/src/job-follow.ts";

const exec = promisify(execFile);
process.env.RCMCP_JOB_CGROUP_ISOLATION = "1";
const available = jobCgroupIsolation();
const jobs: string[] = [];
afterAll(async () => {
  for (const id of jobs) {
    await jobCancel(id).catch(() => undefined);
    await jobRemove(id, true).catch(() => undefined);
    await releaseJobUnit(id);
  }
});
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 8000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error("Synthetic systemd fixture did not reach expected state");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}
const root = process.env.RCMCP_STATE_DIR!;
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

describe.skipIf(!available.ready)(`Linux systemd user integration (${available.ready ? "available" : "SKIP: " + available.reason})`, () => {
  it("survives parent exit, recovers the actual MainPID/cgroup, output and keyed job", async () => {
    const ready = path.join(root, "parent-ready"), release = path.join(root, "parent-release");
    const command = `echo BEFORE; echo ERR >&2; touch ${quote(ready)}; while [ ! -f ${quote(release)} ]; do sleep 0.03; done; echo AFTER; exit 7`;
    const input = { command, idempotencyKey: "parent-exit" };
    const script = path.join(root, "parent.mjs");
    writeFileSync(script, `import { readFileSync } from 'node:fs';
import { jobStart } from ${JSON.stringify(pathToFileURL(path.resolve("apps/agent/src/jobs.ts")).href)};
const job = await jobStart(${JSON.stringify(input)});
console.log(JSON.stringify({job, cgroup: readFileSync('/proc/self/cgroup','utf8')}));
process.exit(0);
`);
    const { stdout } = await exec(process.execPath, [script], { env: process.env, timeout: 15_000 });
    const result = JSON.parse(stdout.trim());
    jobs.push(result.job.id);
    const status = await jobStatusAsync(result.job.id);
    expect(status.state).toBe("running");
    expect(status.systemdUnit).toMatch(/^rcmcp-job-[a-f0-9-]{36}\.service$/);
    const cgroup = readFileSync(`/proc/${status.pid}/cgroup`, "utf8");
    expect(cgroup).not.toBe(result.cgroup);
    expect(cgroup).not.toBe(readFileSync("/proc/self/cgroup", "utf8"));
    expect(cgroup).toContain(status.systemdUnit);
    expect(inspectJobUnit(status.id)?.pid).toBe(status.pid);
    expect(currentProcessIdentity(status.pid)).toBe(status.processIdentity);
    expect(runtimeStatus().capabilities).toContain("job-cgroup-isolation-v1");
    expect((await jobStart(input)).id).toBe(status.id);
    await until(() => existsSync(ready), Boolean);
    expect(jobOutput({ id: status.id, length: 3 }).data).toBe("BEF");
    expect(jobOutput({ id: status.id, stream: "stderr" }).data).toContain("ERR");
    writeFileSync(release, "go");
    const done = await jobFollow({ id: status.id, until: "complete", waitMs: 8000 });
    expect(done).toMatchObject({ state: "completed", exitCode: 7 });
    expect(jobOutput({ id: status.id }).data).toContain("AFTER");
    expect((await jobHistoryPage()).corruptCount).toBe(0);
    await jobRemove(status.id);
  }, 25_000);

  it("fails service admission before effect when the executable cannot start, without fallback", async () => {
    const effect = path.join(root, "rejected-effect");
    const input = { command: `touch ${quote(effect)}`, idempotencyKey: "real-rejected-admission" };
    const executable = process.execPath;
    let rejectedId: string | undefined;
    try {
      // Type=exec must reject execve failure, even though systemd could fork.
      process.execPath = "/definitely/missing/synthetic-job-runtime";
      await jobStart(input).catch(error => {
        expect(error.code).toBe("job_start_uncertain");
        rejectedId = error.jobId;
      });
    } finally { process.execPath = executable; }
    expect(rejectedId).toBeTruthy();
    jobs.push(rejectedId!);
    expect(existsSync(effect)).toBe(false);
    const retry = await jobStart(input);
    expect(retry.id).toBe(rejectedId);
    expect(retry.state).not.toBe("completed");
    expect(existsSync(effect)).toBe(false);
  }, 15_000);

  it("recovers a real service after a lost admission reply without replay or secret diagnostics", async () => {
    const effect = path.join(root, "uncertain-effect"), release = path.join(root, "uncertain-release");
    const originalAdmit = systemd.admitJobUnit;
    const admission = vi.spyOn(systemd, "admitJobUnit").mockImplementationOnce(async (...args) => {
      jobs.push(args[0]);
      await originalAdmit(...args);
      throw new Error("synthetic lost reply");
    });
    const input = { command: `echo once >> ${quote(effect)}; while [ ! -f ${quote(release)} ]; do sleep 0.03; done; echo END`,
      env: { SYNTHETIC_SECRET: "synthetic-private-value" }, idempotencyKey: "lost-real-admission" };
    try {
      await expect(jobStart(input)).rejects.toMatchObject({ code: "job_start_uncertain" });
      const recovered = await jobStart(input);
      expect(recovered.state).toBe("running");
      const lookup = vi.spyOn(systemd, "inspectJobUnitAsync").mockResolvedValueOnce(null);
      expect(await jobStatusAsync(recovered.id)).toMatchObject({ state: "running", recoveryReason: "systemd_unit_lookup_uncertain" });
      lookup.mockRestore();
      expect((await jobStart(input)).id).toBe(recovered.id);
      expect(admission).toHaveBeenCalledTimes(1);
      await until(() => existsSync(effect), Boolean);
      expect(readFileSync(effect, "utf8")).toBe("once\n");
      const diagnostic = (await exec("systemctl", ["--user", "show", recovered.systemdUnit!, "--property=ExecStart,Environment,Description"])).stdout;
      expect(diagnostic).not.toContain(input.command);
      expect(diagnostic).not.toContain("synthetic-private-value");
      expect(diagnostic).not.toContain("SYNTHETIC_SECRET");
      writeFileSync(release, "go");
      expect(await jobFollow({ id: recovered.id, until: "complete", waitMs: 8000 })).toMatchObject({ terminal: true, state: "completed", exitCode: 0 });
      await jobRemove(recovered.id);
    } finally {
      admission.mockRestore();
      writeFileSync(release, "go");
    }
  }, 20_000);

  it("does not trust the exit marker until background descendants have stopped", async () => {
    const job = await jobStart({ command: "sleep 60 & echo RUNNER-DONE" });
    jobs.push(job.id);
    await until(() => existsSync(job.exitPath), Boolean);
    await until(() => inspectJobUnit(job.id)?.sub, sub => sub === "exited");
    expect(await jobStatusAsync(job.id)).toMatchObject({ state: "running", recoveryReason: "exit_marker_runner_still_active" });
    expect(await jobCancel(job.id)).toMatchObject({ state: "cancelled", terminationVerified: true });
    await jobRemove(job.id);
  }, 15_000);

  it("cancels every cgroup descendant including setsid/environment-scrubbed TERM-resistant children", async () => {
    const ready = path.join(root, "tree-ready");
    const job = await jobStart({ command: `setsid env -i /bin/sh -c 'trap "" TERM; echo ready; sleep 60 & wait' & touch ${quote(ready)}; wait` });
    jobs.push(job.id);
    await until(() => existsSync(ready) && jobOutput({ id: job.id }).data.includes("ready"), Boolean);
    const unit = inspectJobUnit(job.id)!;
    const members = readFileSync("/sys/fs/cgroup" + unit.cgroup + "/cgroup.procs", "utf8").trim().split("\n").map(Number);
    expect(members.length).toBeGreaterThanOrEqual(3);
    const identities = members.map(pid => [pid, currentProcessIdentity(pid)] as const);
    const cancel = jobCancel(job.id);
    await until(async () => {
      const status = await jobStatusAsync(job.id);
      expect(status.state).not.toBe("lost");
      if (status.state === "cancelled") expect(jobCgroupEmpty(job.id, unit.cgroup)).toBe(true);
      return status;
    }, s => s.state === "cancelled");
    expect(await cancel).toMatchObject({ state: "cancelled", terminationVerified: true, terminationVerificationScope: "whole_tree" });
    for (const [pid, identity] of identities) expect(currentProcessIdentity(pid)).not.toBe(identity);
    expect((await jobStatusAsync(job.id)).state).toBe("cancelled");
    await jobRemove(job.id);
  }, 20_000);
});
