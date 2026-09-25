import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const originalStateDir = process.env.RCMCP_STATE_DIR;
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-child.pid, "SIGKILL");
    } catch { /* already exited */ }
  }
  vi.resetModules();
  if (originalStateDir === undefined) delete process.env.RCMCP_STATE_DIR;
  else process.env.RCMCP_STATE_DIR = originalStateDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  process.env.RCMCP_STATE_DIR = root;
  vi.resetModules();
  return root;
}

async function liveLegacyProcess() {
  const child = process.platform === "win32"
    ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"], { windowsHide: true })
    : spawn("/bin/bash", ["-lc", "exec sleep 30"], { detached: true, stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("legacy test process has no PID");
  return child;
}

describe("legacy restart compatibility", () => {
  it("tracks a pre-E2 job to its exit marker without signalling an unverified PID", async () => {
    const root = await isolatedRoot("rcmcp-legacy-job-");
    const jobs = path.join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    const child = await liveLegacyProcess();
    const id = "legacy-running";
    const stdoutPath = path.join(jobs, `${id}.stdout.log`);
    const stderrPath = path.join(jobs, `${id}.stderr.log`);
    const exitPath = path.join(jobs, `${id}.exit`);
    await writeFile(stdoutPath, "");
    await writeFile(stderrPath, "");
    await writeFile(path.join(jobs, `${id}.json`), `${JSON.stringify({
      id, command: "legacy", cwd: null, pid: child.pid, state: "running",
      startedAt: new Date().toISOString(), stdoutPath, stderrPath, exitPath,
      ownerInstanceId: "pre-e2-agent",
    })}\n`);

    const mod = await import("../apps/agent/src/jobs.ts");
    expect(mod.jobStatus(id)).toMatchObject({ state: "running", recoveryReason: "legacy_identity_unverified_waiting_for_exit" });
    const cancelled = await mod.jobCancel(id);
    expect(cancelled).toMatchObject({ state: "running", recoveryReason: "legacy_identity_unverified_cannot_cancel_waiting_for_exit" });
    expect(() => process.kill(child.pid!, 0)).not.toThrow();

    await writeFile(exitPath, "0\n");
    expect(mod.jobStatus(id)).toMatchObject({ state: "completed", exitCode: 0 });
    expect(mod.jobStatus(id).recoveryReason).toBeUndefined();
    await mod.jobRemove(id);
  });

  it("guarantees progress for explicit short PTY byte pages", async () => {
    const root = await isolatedRoot("rcmcp-legacy-pty-");
    const ptyRoot = path.join(root, "pty");
    await mkdir(ptyRoot, { recursive: true });
    const id = "short-page";
    const outputPath = path.join(ptyRoot, `${id}.out.log`);
    await writeFile(outputPath, "€tail", "utf8");
    const now = new Date().toISOString();
    await writeFile(path.join(ptyRoot, `${id}.json`), `${JSON.stringify({
      id, pid: 0, shell: "test", cwd: root, cols: 80, rows: 24,
      state: "exited", createdAt: now, updatedAt: now, finishedAt: now,
      outputPath, ownerInstanceId: "test",
    })}\n`);

    const mod = await import("../apps/agent/src/pty.ts");
    const page = mod.ptyOutput(id, 0, 1);
    expect(page).toMatchObject({ bytesRead: 3, nextOffset: 3, eof: false, data: "€" });
    const rest = mod.ptyOutput(id, page.nextOffset, 1);
    expect(rest).toMatchObject({ data: "t", nextOffset: 4 });
    await mod.ptyRemove(id);
  });
});
