import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { runCommand, runProcess } from "../apps/agent/src/exec.ts";

async function waitForFile(file: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not become ready: ${file}`);
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

// These fixtures exercise process-tree deadlines, not the runner account's
// unrelated login profile. Public runCommand login semantics remain covered
// by command, HTTP/stdio and production-canary tests.
describe("shared process-tree runner", () => {
  it.skipIf(process.platform === "win32")("terminates direct process trees at the requested deadline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-exec-ready-"));
    try {
      const ready = path.join(root, "ready");
      const running = runProcess("/bin/bash", ["--noprofile", "--norc", "-c", `trap '' TERM; echo READY > ${quote(ready)}; sleep 20`], { timeoutMs: 250 });
      await waitForFile(ready);
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(3000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("exec reliability", () => {
  it("returns a controlled error for a missing cwd", async () => {
    await expect(runCommand({ command: "echo never", cwd: "/definitely/missing/rcmcp-cwd" })).rejects.toThrow();
    const next = await runCommand({ command: process.platform === "win32" ? "Write-Output alive" : "echo alive" });
    expect(next.stdout).toContain("alive");
  });

  it("terminates a process tree within a bounded interval after timeout", async () => {
    const root = process.platform === "win32" ? null : await mkdtemp(path.join(os.tmpdir(), "rcmcp-exec-ready-"));
    const command = process.platform === "win32"
      ? "$p=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 5' -PassThru; Write-Output $p.Id; Wait-Process -Id $p.Id"
      : `echo READY > ${quote(path.join(root!, "ready"))}; trap '' TERM; sleep 5`;
    const started = Date.now();
    const running = process.platform === "win32"
      ? runCommand({ command, timeoutMs: 500 })
      : runProcess("/bin/bash", ["--noprofile", "--norc", "-c", command], { timeoutMs: 500 });
    if (root) await waitForFile(path.join(root, "ready"));
    const result = await running;
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    if (process.platform === "win32") {
      expect(result.terminationVerified).toBe(false);
      expect(result.terminationVerification).toMatch(/partial_windows_job|unverified_windows_fallback/);
      expect(result.terminationReason ?? result.terminationError).toBeTruthy();
    } else {
      expect(result.terminationVerified).toBe(true);
    }
    expect(elapsed).toBeLessThan(3000);

    if (process.platform === "win32") {
      const pid = Number.parseInt(result.stdout.trim().split(/\r?\n/)[0] ?? "", 10);
      if (Number.isFinite(pid)) {
        const tasklist = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
        expect(tasklist).not.toMatch(new RegExp(`\\b${pid}\\b`));
      }
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("waits for TERM-resistant descendants after the shell exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-exec-ready-"));
    try {
      const ready = path.join(root, "ready");
      const pidFile = path.join(root, "child.pid");
      const command = `(trap '' TERM; exec sleep 20) >/dev/null 2>&1 & child=$!; echo $child > ${quote(pidFile)}; touch ${quote(ready)}; wait`;
      const running = process.platform === "win32"
      ? runCommand({ command, timeoutMs: 500 })
      : runProcess("/bin/bash", ["--noprofile", "--norc", "-c", command], { timeoutMs: 500 });
      await waitForFile(ready);
      const descendant = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect(Number.isFinite(descendant)).toBe(true);
      expect(() => process.kill(descendant, 0)).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});


describe("M15 final async execution lifecycle", () => {
  it.skipIf(process.platform === "win32")("keeps the agent event loop responsive while terminating a stubborn process tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-exec-ready-"));
    const ready = path.join(root, "ready");
    let ticks = 0;
    let maxGap = 0;
    let previous = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - previous);
      previous = now;
      ticks += 1;
    }, 20);
    try {
      const running = runProcess("/bin/bash", ["--noprofile", "--norc", "-c", `trap '' TERM; echo READY > ${quote(ready)}; sleep 20`], { timeoutMs: 500 });
      await waitForFile(ready);
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect(result.terminationVerified).toBe(true);
    } finally {
      clearInterval(interval);
      await rm(root, { recursive: true, force: true });
    }
    expect(ticks).toBeGreaterThan(5);
    expect(maxGap).toBeLessThan(400);
  });

  it.skipIf(process.platform !== "win32")("arms the timeout before Windows process-identity lookup can delay the event loop", async () => {
    const result = await runCommand({ command: "Start-Sleep -Milliseconds 80; Write-Output finished", timeoutMs: 5 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(3000);
  });
});
