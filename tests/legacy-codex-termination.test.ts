import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import { runProcess } from "../apps/agent/src/exec.ts";
import { jobCancel, jobRemove, jobStart, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { ptyRemove, ptyStart, ptyTerminate } from "../apps/agent/src/pty.ts";

const roots: string[] = [];
const escaped = new Set<number>();
afterEach(async () => {
  for (const pid of escaped) { try { process.kill(pid, "SIGKILL"); } catch {} }
  escaped.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const child = path.join(root, "child.cjs");
  const parent = path.join(root, "parent.cjs");
  const ready = path.join(root, "ready");
  const childPid = path.join(root, "child.pid");
  await writeFile(child, "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n");
  await writeFile(parent, [
    "#!/usr/bin/env node",
    "const {spawn}=require('node:child_process'); const fs=require('node:fs');",
    "process.on('SIGTERM',()=>{ const c=spawn(process.execPath,[" + JSON.stringify(child) + "],{detached:true,stdio:'ignore',env:{}}); c.unref(); fs.writeFileSync(" + JSON.stringify(childPid) + ",String(c.pid)); process.exit(0); });",
    "fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');",
    "setInterval(()=>{},1000);",
  ].join("\n") + "\n");
  await chmod(parent, 0o755);
  return { root, parent, ready, childPid };
}

async function waitFor(file: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  if (!existsSync(file)) throw new Error("fixture did not become ready: " + file);
}

async function escapedPid(file: string) {
  await waitFor(file);
  const pid = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
  expect(pid).toBeGreaterThan(0);
  escaped.add(pid);
  expect(() => process.kill(pid, 0)).not.toThrow();
  return pid;
}

it.skipIf(process.platform === "win32")("does not claim whole-tree verification when a TERM handler launches a detached env-scrubbed child", async () => {
  const f = await fixture("rcmcp-legacy-exec-");
  const running = runProcess(process.execPath, [f.parent], { timeoutMs: 150 });
  await waitFor(f.ready);
  const result = await running;
  await escapedPid(f.childPid);
  expect(result.timedOut).toBe(true);
  expect(result.terminationVerified).toBe(false);
  expect(result.terminationVerificationScope).toBe("unverified");
  expect(result.terminationReason).toBe("posix_observed_tree_stopped_escape_not_excluded");
});

it.skipIf(process.platform === "win32")("keeps PTY termination truthful when a detached env-scrubbed child escapes", async () => {
  const f = await fixture("rcmcp-legacy-pty-");
  const session = await ptyStart({ shell: f.parent, cwd: f.root });
  try {
    await waitFor(f.ready);
    const result = await ptyTerminate(session.id);
    await escapedPid(f.childPid);
    expect(result.exited).toBe(true);
    expect(result.terminationVerified).toBe(false);
    expect(result.terminationVerificationScope).toBe("unverified");
    expect(result.terminationReason).toBe("posix_observed_tree_stopped_escape_not_excluded");
  } finally {
    await ptyRemove(session.id, true).catch(() => undefined);
  }
});

it.skipIf(process.platform === "win32")("never publishes cancelled for a job whose detached env-scrubbed descendant cannot be excluded", async () => {
  const f = await fixture("rcmcp-legacy-job-");
  const job = await jobStart({ command: "exec " + JSON.stringify(process.execPath) + " " + JSON.stringify(f.parent), cwd: f.root });
  try {
    await waitFor(f.ready);
    const cancelled = await jobCancel(job.id);
    await escapedPid(f.childPid);
    expect(cancelled.state).not.toBe("cancelled");
    expect(cancelled.terminationVerified).toBe(false);
    let status = await jobStatusAsync(job.id);
    const deadline = Date.now() + 1500;
    while (status.state === "cancelling" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      status = await jobStatusAsync(job.id);
    }
    expect(status.state).toBe("lost");
    expect(status.terminationVerified).toBe(false);
    expect(status.recoveryReason).toMatch(/unverified|incomplete/);
  } finally {
    await jobRemove(job.id, false).catch(() => undefined);
  }
});
