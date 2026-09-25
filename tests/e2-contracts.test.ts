import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { startJobsMany } from "../apps/mcp-server/src/job-tools.ts";
import { runtimeStatus } from "../apps/agent/src/runtime.ts";

const runtimeRoots: string[] = [];
const originalStateDir = process.env.RCMCP_STATE_DIR;
afterEach(async () => {
  vi.resetModules();
  if (originalStateDir === undefined) delete process.env.RCMCP_STATE_DIR;
  else process.env.RCMCP_STATE_DIR = originalStateDir;
  await Promise.all(runtimeRoots.splice(0).map((root) => chmod(root, 0o700).catch(() => undefined).then(() => rm(root, { recursive: true, force: true }))));
});

describe("E2 contracts", () => {
  it("bounds multi-host job scheduling while preserving input order", async () => {
    let active = 0;
    let peak = 0;
    const fake = {
      jobStart: async (device: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { id: `${device}-job`, state: "running" };
      },
    } as unknown as AgentClient;
    const devices = Array.from({ length: 12 }, (_, i) => `device-${i}`);
    const results = await startJobsMany(fake, devices, { command: "echo ok" }, "system", 3);
    expect(peak).toBe(3);
    expect(results.map((item) => item.device)).toEqual(devices);
    expect(results.every((item) => item.ok)).toBe(true);
  });

  it("returns partial per-device results when one multi-host job start fails", async () => {
    const fake = {
      jobStart: async (device: string) => {
        if (device === "offline") throw new Error("connection refused");
        return { id: `${device}-job`, state: "running" };
      },
    } as unknown as AgentClient;
    const results = await startJobsMany(fake, ["server", "offline", "Gaming"], { command: "echo ok" }, "system");
    expect(results).toEqual([
      { device: "server", context: "system", ok: true, job: { id: "server-job", state: "running" } },
      { device: "offline", context: "system", ok: false, error: "connection refused" },
      { device: "Gaming", context: "system", ok: true, job: { id: "Gaming-job", state: "running" } },
    ]);
  });


  it.skipIf(process.platform === "win32")("probes the configured state directory instead of requiring a writable parent", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "rcmcp-state-ready-"));
    runtimeRoots.push(parent);
    const state = path.join(parent, "delegated-state");
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o555);
    process.env.RCMCP_STATE_DIR = state;
    vi.resetModules();
    const runtime = await import("../apps/agent/src/runtime.ts");
    expect(runtime.runtimeStatus()).toMatchObject({ ready: true, stateRoot: state, checks: { state: { ready: true } } });
  });

  it("keeps spawned job and PTY cleanup inside persistence failure paths", () => {
    const jobs = readFileSync("apps/agent/src/jobs.ts", "utf8");
    const pty = readFileSync("apps/agent/src/pty.ts", "utf8");
    expect(jobs).toContain("const cleanupErrors = cleanupJobArtifacts(meta);");
    expect(jobs).toContain("if (stopped) {");
    expect(jobs).not.toContain("for (const file of [metaPath(id), stdoutPath, stderrPath, donePath, progressPath(id)]) rmSync(file, { force: true })");
    expect(pty).toContain("let published = false;");
    expect(pty).toContain("await cleanupFailedPtyStart(session");
    expect(pty).toContain("terminateVerifiedProcessTree(meta.pid, meta.processIdentity, meta.createdAt, 1000");
    expect(pty).toContain('"RCMCP_PTY_SESSION_ID=" + meta.id');
    expect(pty).toContain("rmSync(meta.outputPath, { force: true })");
  });

  it("keeps search setup and stream persistence failures inside lifecycle cleanup", () => {
    const search = readFileSync("apps/agent/src/search-sessions.ts", "utf8");
    expect(search).toContain("await cleanupFailedSearchStart(session, \"search_metadata_registration_failed\", true);");
    expect(search).toContain("const identity = await currentProcessIdentityAsync(child.pid);");
    expect(search).toContain("for (const file of [metaPath(session.meta.id), session.meta.resultsPath, session.meta.stderrPath]) rmSync(file, { force: true });");
    expect(search).toContain("Search stderr persistence failed:");
    expect(search).toContain("try { writeMeta(session.meta); }");
    expect(search).toContain('try { session.child.kill("SIGTERM"); }');
  });

  it("reports stable runtime identity, capabilities and readiness details", () => {
    const first = runtimeStatus();
    const second = runtimeStatus();
    expect(first.instanceId).toBe(second.instanceId);
    expect(first.startedAt).toBe(second.startedAt);
    expect(first.pid).toBe(process.pid);
    expect(first.capabilities).toContain("exec");
    expect(first.capabilities).toContain("filesystem");
    expect(typeof first.ready).toBe("boolean");
    expect(first.checks).toHaveProperty("state.ready");
    expect(first.checks).toHaveProperty("search.ready");
    expect(["system", "user", "desktop", "unknown"]).toContain(first.context);
  });
});
