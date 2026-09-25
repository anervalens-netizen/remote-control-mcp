import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runProcess } from "../apps/agent/src/exec.ts";
import { jobCancel, jobRemove, jobStart, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { currentProcessIdentityAsync, matchesStoredProcessIdentityAsync, processAlive, terminateVerifiedProcessTreeDetailedAsync } from "../apps/agent/src/process-identity.ts";
import { redactGitText } from "../apps/agent/src/repo.ts";

const execFileAsync = promisify(execFile);

describe("M16 lifecycle lane", () => {
  it("redacts credential-bearing Git query parameters as well as URL userinfo", () => {
    const text = "fetch https://owner:basic-secret@example.invalid/repo.git?access_token=query-secret&ref=main&api_key=another-secret";
    const redacted = redactGitText(text);
    expect(redacted).not.toContain("basic-secret");
    expect(redacted).not.toContain("query-secret");
    expect(redacted).not.toContain("another-secret");
    expect(redacted).toContain("access_token=***");
    expect(redacted).toContain("ref=main");
  });

  it("serializes concurrent cancellation callers and never regresses the terminal state", async () => {
    const job = await jobStart({ command: process.platform === "win32" ? "Start-Sleep -Seconds 20" : "trap '' TERM; sleep 20" });
    try {
      const [first, second] = await Promise.all([jobCancel(job.id), jobCancel(job.id)]);
      if (process.platform === "win32") {
        expect(first.state).toBe("lost");
        expect(second.state).toBe("lost");
        expect(second.recoveryReason).toMatch(/unverified/);
      } else {
        expect(first.state).toBe("cancelled");
        expect(second.state).toBe("cancelled");
        expect(second.state === "cancelling" || second.state === "cancelled").toBe(true);
      }
    } finally {
      await jobRemove(job.id, true).catch(() => undefined);
    }
  }, 10_000);

  it("refuses a termination request whose stored identity does not match the live PID", async () => {
    const identity = await currentProcessIdentityAsync(process.pid);
    const result = await terminateVerifiedProcessTreeDetailedAsync(process.pid, "definitely-not-the-current-process", new Date().toISOString(), 100);
    expect(identity).toBeTruthy();
    expect(result.terminated).toBe(false);
    expect(processAlive(process.pid)).toBe(true);
  });

  it("keeps Windows request paths free of synchronous identity/process probes", () => {
    const source = (file: string) => readFileSync(path.resolve("apps/agent/src", file), "utf8");
    expect(source("pty.ts")).not.toMatch(/spawnSync|currentProcessIdentity\(/);
    expect(source("search-sessions.ts")).not.toMatch(/spawnSync|execFileSync/);
    expect(source("jobs.ts")).not.toMatch(/execFileSync/);
    expect(source("repo.ts")).not.toMatch(/execFileSync|spawnSync/);
    const tracker = readFileSync(path.resolve("apps/agent/src/windows-process-tracker.ts"), "utf8");
    expect(tracker).not.toContain("KillOnClose");
    expect(tracker).toContain("GetProcessTimes");
    expect(tracker).toContain("QueryInformationJobObject");
    expect(tracker).toContain("TerminateJobObject");
    expect(tracker).toContain("RCMCP_TRACK_IDENTITY");
    expect(source("extra-routes.ts")).toContain("jobStatusAsync");
    const identitySource = source("process-identity.ts");
    const windowsTermination = identitySource.slice(identitySource.indexOf('    const tracker = trackedWindowsProcess(pid, storedIdentity);'), identitySource.indexOf('  if (!rootInitiallyVerified && !environmentMarker) return { terminated: false, forced: false };', identitySource.indexOf('export async function terminateVerifiedProcessTreeDetailedAsync')));
    expect(windowsTermination).not.toContain("matchesStoredProcessIdentityAsync");
    expect(windowsTermination).toContain("terminateWindowsPinnedRoot");
    expect(identitySource).toContain("$h=$p.Handle");
    expect(identitySource).toContain("$p.StartTime.ToUniversalTime().Ticks) -ne $env:RCMCP_KILL_IDENTITY");
  });

  it.skipIf(process.platform !== "win32")("requires a live grandchild and reports post-launch Job Object coverage as partial", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m16-windows-tree-"));
    const grandchildScript = path.join(root, "grandchild.cjs");
    const intermediateScript = path.join(root, "intermediate.cjs");
    const rootScript = path.join(root, "root.cjs");
    const ready = path.join(root, "grandchild-ready.pid");
    const release = path.join(root, "grandchild-release");
    const completed = path.join(root, "grandchild-completed.txt");
    let pid = 0;
    let grandchildIdentity: string | undefined;
    let running: ReturnType<typeof runProcess> | undefined;
    let cleanupVerified = false;
    const wait = () => new Promise((resolve) => setTimeout(resolve, 25));
    try {
      // The original fixture used three fresh PowerShell processes and assumed
      // its grandchild's Start-Sleep(3) would finish within a fixed poll budget.
      // Passing runs wrote the completion marker: they proved natural exit, not
      // tree termination. Use a fast native Node fixture with an explicit
      // readiness/release handshake, while keeping the product's 2s deadline.
      await writeFile(grandchildScript, [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`,
        `const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { fs.writeFileSync(${JSON.stringify(completed)}, 'done'); clearInterval(timer); } }, 20);`,
      ].join("\n"));
      await writeFile(intermediateScript, [
        "const { spawn } = require('node:child_process');",
        `const child = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore', windowsHide: true });`,
        "child.unref();",
      ].join("\n"));
      await writeFile(rootScript, [
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, [${JSON.stringify(intermediateScript)}], { stdio: 'ignore', windowsHide: true }).unref();`,
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      running = runProcess(process.execPath, [rootScript], { timeoutMs: 2_000 });
      const markerDeadline = Date.now() + 4_000;
      while (Date.now() < markerDeadline) {
        if (existsSync(ready)) {
          pid = Number.parseInt(await readFile(ready, "utf8"), 10);
          if (pid > 0) {
            grandchildIdentity = (await currentProcessIdentityAsync(pid)) ?? undefined;
            if (grandchildIdentity && await matchesStoredProcessIdentityAsync(pid, grandchildIdentity)) break;
          }
        }
        await wait();
      }
      expect(pid).toBeGreaterThan(0);
      expect(grandchildIdentity).toBeTruthy();
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect(result.terminationVerified).toBe(false);
      expect(result.terminationVerification).toMatch(/partial_windows_job|unverified_windows_fallback/);
      expect(result.terminationReason ?? result.terminationError).toBeTruthy();
      // A partial result must not be treated as proof that an escaped child
      // stopped. There can be no natural timer completion before our release.
      expect(existsSync(completed)).toBe(false);
      const survivedTimeout = await matchesStoredProcessIdentityAsync(pid, grandchildIdentity);
      await writeFile(release, "release");
      const exitDeadline = Date.now() + 5_000;
      let stillAlive = true;
      while (Date.now() < exitDeadline) {
        stillAlive = await matchesStoredProcessIdentityAsync(pid, grandchildIdentity);
        if (!stillAlive) break;
        await wait();
      }
      expect(stillAlive).toBe(false);
      if (survivedTimeout) expect(existsSync(completed)).toBe(true);
      cleanupVerified = true;
    } finally {
      // Release only this fixture; do not leave an escaped process behind when
      // an assertion fails, or signal a recycled PID without its bound identity.
      await writeFile(release, "release").catch(() => undefined);
      await running?.catch(() => undefined);
      if (grandchildIdentity && await matchesStoredProcessIdentityAsync(pid, grandchildIdentity)) {
        await terminateVerifiedProcessTreeDetailedAsync(pid, grandchildIdentity, undefined, 1000);
        const stopDeadline = Date.now() + 2000;
        while (await matchesStoredProcessIdentityAsync(pid, grandchildIdentity) && Date.now() < stopDeadline) await wait();
      }
      if (grandchildIdentity) cleanupVerified = !(await matchesStoredProcessIdentityAsync(pid, grandchildIdentity));
      if (cleanupVerified) await rm(root, { recursive: true, force: true });
      else console.error(`Windows fixture evidence retained for unverified cleanup: ${root}`);
    }
  }, 15_000);

  it.skipIf(process.platform !== "win32")("keeps a durable job alive across helper disconnect and module reload", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-tracker-handshake-"));
    const release = path.join(root, "release");
    const quoted = "'" + release.replaceAll("'", "''") + "'";
    const first = await jobStart({ command: `while(-not(Test-Path -LiteralPath ${quoted})){Start-Sleep -Milliseconds 20}; Write-Output DURABLE_AFTER_RELOAD` });
    try {
      const tracker = await import("../apps/agent/src/windows-process-tracker.ts");
      const attached = await tracker.trackedWindowsProcess(first.pid, first.processIdentity);
      expect(attached).toBeTruthy();
      await tracker.disconnectWindowsProcessTracker(first.pid, first.processIdentity);
      vi.resetModules();
      const second = await import("../apps/agent/src/jobs.ts");
      await writeFile(release, "continue");
      const deadline = Date.now() + 8_000;
      let status = await second.jobStatusAsync(first.id);
      while ((status.state === "running" || status.state === "cancelling") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        status = await second.jobStatusAsync(first.id);
      }
      expect(status.state).toBe("completed");
      expect(second.jobOutput({ id: first.id, offset: 0, length: 4096 }).data).toContain("DURABLE_AFTER_RELOAD");
    } finally {
      await writeFile(release, "continue");
      await jobRemove(first.id, true);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 25_000);
});
