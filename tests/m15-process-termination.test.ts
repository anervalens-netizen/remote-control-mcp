import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../apps/agent/src/exec.ts";
import { jobCancel, jobRemove, jobStart, jobStatus } from "../apps/agent/src/jobs.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForFile(file: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

describe.skipIf(process.platform === "win32")("M15 W3 escaped Linux descendants", () => {
  it("bounds exec timeout and verifies termination of a setsid descendant holding stdout", async () => {
    const started = Date.now();
    const result = await runProcess("/bin/bash", ["--noprofile", "--norc", "-c", "setsid /bin/bash -c 'sleep 1.5; printf ESCAPED_FINISHED' & wait"], {
      timeoutMs: 100,
      maxOutputBytes: 4096,
    });
    const elapsed = Date.now() - started;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    expect(result.stdout).not.toContain("ESCAPED_FINISHED");
    expect((result as any).terminationVerified).toBe(true);
    expect((result as any).drainTimedOut).toBe(false);
  });

  it("finds a marker-owned setsid descendant even after the root shell exits", async () => {
    const result = await runProcess("/bin/bash", ["--noprofile", "--norc", "-c", "setsid /bin/bash -c 'sleep 1.5; printf ROOT_GONE_SURVIVOR' & exit 0"], {
      timeoutMs: 100,
      maxOutputBytes: 4096,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain("ROOT_GONE_SURVIVOR");
    expect((result as any).terminationVerified).toBe(true);
    expect(result.durationMs).toBeLessThan(1200);
  });

  it("uses the lineage ledger after a vanished root scrubs marker and session ancestry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-ready-"));
    const ready = path.join(root, "ready");
    try {
      const escaped = `setsid /bin/bash -c "echo READY > ${ready}; sleep 0.9; printf UNTRACKED_SURVIVOR"`;
      const command = `env -i PATH=/usr/bin:/bin /bin/bash -c ${quote(`${escaped} & child=$!; while [ ! -s ${quote(ready)} ]; do sleep 0.01; done; sleep 0.15; exit 0`)}`;
      const started = Date.now();
      const running = runProcess("/bin/bash", ["--noprofile", "--norc", "-c", command], { timeoutMs: 500, maxOutputBytes: 4096 });
      await waitForFile(ready, 2_000);
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect((result as any).terminationVerified).toBe(true);
      expect((result as any).terminationVerification).toBe("posix_identity_set");
      expect((result as any).drainTimedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish cancelled while a marker-owned setsid descendant can still mutate", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-job-"));
    roots.push(root);
    const pidFile = path.join(root, "child.pid");
    const marker = path.join(root, "survived.txt");
    const command = `setsid /bin/bash -c 'echo $$ > "${pidFile}"; sleep 3; printf SURVIVED_CANCEL > "${marker}"' & wait`;
    const job = await jobStart({ command, cwd: root });
    try {
      await waitForFile(pidFile);
      const childPid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      expect(Number.isFinite(childPid)).toBe(true);
      expect(existsSync(marker)).toBe(false);

      const cancelled = await jobCancel(job.id);
      expect(cancelled.state).toBe("cancelled");
      expect((cancelled as any).terminationVerified).toBe(true);
      expect(() => process.kill(childPid, 0)).toThrow();

      await new Promise((resolve) => setTimeout(resolve, 3250));
      expect(existsSync(marker)).toBe(false);
      expect(jobStatus(job.id).state).toBe("cancelled");
    } finally {
      await jobRemove(job.id, true).catch(() => undefined);
    }
  }, 10_000);
});
