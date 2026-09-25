import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeExitMarkerDurably } from "../apps/agent/src/job-exit-marker.ts";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { jobCancel, jobList, jobOutput, jobRemove, jobStart, jobStatus } from "../apps/agent/src/jobs.ts";
import { verifiedProcessTreeAlive } from "../apps/agent/src/process-identity.ts";
import { nativeCommand } from "../apps/agent/src/shell-quote.ts";

// These are completion/output assertions, not a four-second runtime SLA. Native
// Windows starts a detached PowerShell wrapper and reconciles process identity;
// allow that fixture work inside Vitest's existing Windows test budget. Explicit
// per-case deadlines below and every product timeout remain unchanged.
async function waitDone(id: string, timeoutMs = process.platform === "win32" ? 15_000 : 4000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: ReturnType<typeof jobStatus> | undefined;
  while (Date.now() < deadline) {
    const status = jobStatus(id);
    lastStatus = status;
    if (status.state !== "running" && status.state !== "cancelling") return status;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Job ${id} did not finish within ${timeoutMs}ms: ${JSON.stringify({
    state: lastStatus?.state, exitCode: lastStatus?.exitCode, recoveryReason: lastStatus?.recoveryReason,
  })}`);
}

describe("durable job exit marker", () => {
  it("activates a synced marker without leaving staging files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-job-marker-"));
    try {
      const marker = path.join(root, "job.exit");
      const stdout = path.join(root, "job.stdout.log");
      const stderr = path.join(root, "job.stderr.log");
      await writeFile(stdout, "OUT\n");
      await writeFile(stderr, "ERR\n");
      writeExitMarkerDurably(marker, 17, [stdout, stderr]);
      expect(await readFile(marker, "utf8")).toBe("17\n");
      expect(await readFile(stdout, "utf8")).toBe("OUT\n");
      expect(await readFile(stderr, "utf8")).toBe("ERR\n");
      expect((await readdir(root)).filter((name) => name.includes(".tmp."))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("durable jobs", () => {
  it("captures paginated output and persists a completed status", async () => {
    const command = process.platform === "win32"
      ? "Write-Output START; Start-Sleep -Milliseconds 150; Write-Output END"
      : "echo START; sleep 0.15; echo END";
    const job = await jobStart({ command });
    try {
      const done = await waitDone(job.id);
      expect(done.state).toBe("completed");
      expect(done.exitCode).toBe(0);
      const output = jobOutput({ id: job.id, offset: 0, length: 1024 });
      expect(output.data).toContain("START");
      expect(output.data).toContain("END");
      expect(jobList().some((item) => item.id === job.id)).toBe(true);
      expect(await jobRemove(job.id)).toEqual({ id: job.id, removed: true });
    } finally {
      // A failed assertion must not leave this synthetic runner affecting later tests.
      await jobRemove(job.id, true).catch(() => undefined);
    }
  });

  it("keeps durable job stdout and stderr UTF-8 decodable", async () => {
    const command = process.platform === "win32"
      ? '[Console]::Out.WriteLine("UTF8-€"); [Console]::Error.WriteLine("ERR-€")'
      : 'printf "UTF8-€\n"; printf "ERR-€\n" >&2';
    const job = await jobStart({ command });
    try {
      const done = await waitDone(job.id);
      expect(done).toMatchObject({ state: "completed", exitCode: 0 });
      expect(jobOutput({ id: job.id, stream: "stdout", offset: 0, length: 1024 }).data).toContain("UTF8-€");
      expect(jobOutput({ id: job.id, stream: "stderr", offset: 0, length: 1024 }).data).toContain("ERR-€");
      await jobRemove(job.id);
    } finally {
      await jobRemove(job.id, true).catch(() => undefined);
    }
  });

  it("does not trust a premature exit marker while the verified runner is still alive", async () => {
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const job = await jobStart({ command });
    try {
      await writeFile(job.exitPath, "0\n");
      const status = jobStatus(job.id);
      expect(status.state).toBe("running");
      expect(status.recoveryReason).toBe("exit_marker_runner_still_active");
    } finally {
      await jobCancel(job.id).catch(() => undefined);
      await jobRemove(job.id, true).catch(() => undefined);
    }
  }, 15_000);

  it("rejects invalid cwd cleanly and can start a later job", async () => {
    const before = jobList().map((item) => item.id);
    await expect(jobStart({ command: "echo never", cwd: "/definitely/missing/rcmcp-job-cwd" })).rejects.toThrow();
    expect(jobList().map((item) => item.id)).toEqual(before);
    const command = process.platform === "win32" ? "Write-Output RECOVERED" : "echo RECOVERED";
    const job = await jobStart({ command });
    try {
      const done = await waitDone(job.id);
      expect(done.state).toBe("completed");
      await jobRemove(job.id);
    } finally {
      await jobRemove(job.id, true).catch(() => undefined);
    }
  });

  it("preserves a failed cancellation verification when the runner later exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-cancel-verification-"));
    const release = path.join(root, "release");
    const script = path.join(root, "wait.cjs");
    await writeFile(script, [
      'const fs=require("node:fs");',
      'const target=process.argv[2];',
      'const timer=setInterval(()=>{if(fs.existsSync(target)){clearInterval(timer);process.exit(0)}},10);',
    ].join("\n"));
    const job = await jobStart({ cwd: root, command: nativeCommand([process.execPath, script, release]) });
    try {
      const metadataPath = path.join(path.dirname(job.stdoutPath), job.id + ".json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.state = "cancelling";
      metadata.terminationVerified = false;
      metadata.recoveryReason = "fixture_verification_failed";
      await writeFile(metadataPath, JSON.stringify(metadata) + "\n");
      await writeFile(release, "go");
      const done = await waitDone(job.id, 8000);
      expect(done.state === "cancelled" || done.state === "lost").toBe(true);
      expect(done.terminationVerified).toBe(false);
      if (process.platform !== "win32") expect(done.recoveryReason).toBe("fixture_verification_failed");
    } finally {
      await jobRemove(job.id, true).catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  }, 12000);

  it("cancels a running process tree before reporting cancelled", async () => {
    const command = process.platform === "win32"
      ? "Start-Sleep -Seconds 20"
      : "trap '' TERM; sleep 20";
    const job = await jobStart({ command });
    const cancelled = await jobCancel(job.id);
    if (process.platform === "win32") {
      expect(cancelled.state).toBe("lost");
      expect(cancelled.terminationVerified).toBe(false);
      expect(cancelled.recoveryReason).toMatch(/unverified/);
    } else {
      expect(cancelled.state).toBe("cancelled");
      expect(verifiedProcessTreeAlive(job.pid, job.processIdentity, job.startedAt, job.executionMarker)).toBe(false);
      expect(cancelled.terminationVerified).toBe(true);
    }
    await jobRemove(job.id);
  });

  it.skipIf(process.platform === "win32")("keeps cancellation non-terminal while a TERM-resistant descendant is alive", async () => {
    const job = await jobStart({ command: "(trap '' TERM; exec sleep 20) >/dev/null 2>&1 & echo $!; wait" });
    const cancelling = jobCancel(job.id);
    let falseTerminal = false;
    let settled = false;
    void cancelling.finally(() => { settled = true; });
    while (!settled) {
      const status = jobStatus(job.id);
      if (
        status.state === "cancelled"
        && verifiedProcessTreeAlive(job.pid, job.processIdentity, job.startedAt, job.executionMarker)
      ) {
        falseTerminal = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const done = await cancelling;
    expect(falseTerminal).toBe(false);
    expect(done.state).toBe("cancelled");
    expect(done.terminationVerified).toBe(true);
    expect(verifiedProcessTreeAlive(job.pid, job.processIdentity, job.startedAt, job.executionMarker)).toBe(false);
    await jobRemove(job.id);
  });
});
