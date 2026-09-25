import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fsManage } from "../apps/agent/src/filesystem.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { projectRun } from "../apps/agent/src/project-run.ts";
import { runProcess } from "../apps/agent/src/exec.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { nativeCommand } from "../apps/agent/src/shell-quote.ts";
import { processAlive } from "../apps/agent/src/process-identity.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  vi.doUnmock("../apps/agent/src/process-identity.ts");
  vi.doUnmock("../apps/agent/src/state.ts");
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function waitForFile(file: string, timeoutMs = process.platform === "win32" ? 15_000 : 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fixture did not become ready: ${file}`);
}

describe("RC25-01 foreground cancellation", () => {
  it("has no effect when project exec is pre-aborted and keeps durable jobs independent", async () => {
    const root = await tempRoot("rcmcp-rc25-preabort-");
    const effect = path.join(root, "effect");
    const signal = AbortSignal.abort(new Error("pre-aborted"));
    const input = { path: root, executable: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)},'durable')`] };
    await expect(projectRun({ ...input, mode: "exec" }, signal)).rejects.toThrow();
    expect(existsSync(effect)).toBe(false);

    const durable = await projectRun({ ...input, mode: "job" }, signal);
    const job = durable.result as { id: string };
    const jobs = await import("../apps/agent/src/jobs.ts");
    try {
      await waitForFile(effect); // Shell/runner startup has its own readiness budget.
      await vi.waitFor(async () => expect((await jobs.jobStatusAsync(job.id)).state).toBe("completed"), { timeout: 5000 });
      expect(await readFile(effect, "utf8")).toBe("durable");
    } finally { await jobs.jobRemove(job.id, true); }
  }, 40_000);

  it("terminates the real process tree through an MCP cancellation without replaying the command", async () => {
    const root = await tempRoot("rcmcp-rc25-mcp-cancel-");
    const ready = path.join(root, "ready");
    const late = path.join(root, "late");
    const agent = Fastify();
    registerExtraRoutes(agent);
    const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => { await agent.close(); });

    const mcpServer = new (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer({ name: "rc25", version: "1" });
    const client = new AgentClient([{ name: "pc", url: agentUrl, userUrl: agentUrl }]);
    registerHighLevelTools(mcpServer, client);
    const mcpClient = new Client({ name: "rc25-client", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
    closers.push(async () => { await mcpClient.close(); await mcpServer.close(); });

    const controller = new AbortController();
    const release = path.join(root, "release"), childReady = path.join(root, "child-ready"), launches = path.join(root, "launches");
    const script = path.join(root, "tree.cjs");
    await writeFile(script, `
      const fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      if(process.argv[2]==='child') {
        fs.writeFileSync(${JSON.stringify(childReady)}+'.tmp',String(process.pid));
        fs.renameSync(${JSON.stringify(childReady)}+'.tmp',${JSON.stringify(childReady)});
        setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.writeFileSync(${JSON.stringify(late)},'late');process.exit(0)}},20);
      } else {
        fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');
        require('node:child_process').spawn(process.execPath,[__filename,'child'],{stdio:'inherit'});
        const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(childReady)})){fs.writeFileSync(${JSON.stringify(ready)}+'.tmp',String(process.pid));fs.renameSync(${JSON.stringify(ready)}+'.tmp',${JSON.stringify(ready)});clearInterval(timer)}},20);
        setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},20);
      }
    `);
    const pending = mcpClient.callTool({
      name: "project_run",
      arguments: { device: "pc", path: root, executable: process.execPath, args: [script], mode: "exec", timeoutMs: 0 },
    }, undefined, { signal: controller.signal });
    void pending.catch(() => undefined);
    try {
      await waitForFile(ready);
      const pids = [Number(await readFile(ready, "utf8")), Number(await readFile(childReady, "utf8"))];
      expect(pids.every(processAlive)).toBe(true);
      controller.abort(new Error("RC25 MCP cancellation"));
      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(pids.some(processAlive)).toBe(false), { timeout: 10_000 });
      // Release only after both real processes have stopped: no timer races.
      await writeFile(release, "go");
      expect(existsSync(late)).toBe(false);
      expect(await readFile(launches, "utf8")).toBe("launch\n");
    } finally {
      controller.abort(); await writeFile(release, "cleanup"); await pending.catch(() => undefined);
    }
  }, 40_000);

  it("reports caller cancellation separately from timeout and verifies termination", async () => {
    const root = await tempRoot("rcmcp-rc25-runner-");
    const ready = path.join(root, "ready");
    const controller = new AbortController();
    const running = process.platform === "win32"
      ? runProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath '${ready.replaceAll("'", "''")}' -Value READY; Start-Sleep -Seconds 20`], { timeoutMs: 0, signal: controller.signal })
      : runProcess("/bin/bash", ["--noprofile", "--norc", "-c", `printf READY > ${JSON.stringify(ready)}; trap '' TERM; sleep 20`], { timeoutMs: 0, signal: controller.signal });
    let result;
    try {
      await waitForFile(ready);
      controller.abort(new Error("RC25 runner cancellation"));
      result = await running;
    } finally { controller.abort(); await running; }
    expect(result.cancellationRequested).toBe(true);
    expect(result.timedOut).toBe(false);
    if (process.platform !== "win32") {
      expect(result.terminationVerified).toBe(true);
      expect(result.cancelled).toBe(true);
    }
  }, 40_000);
});

describe("RC25-02 job-start recovery evidence", () => {
  async function mockedJobs(options: { terminate: "verified" | "unverified" | "throw"; publishThenThrow?: boolean }) {
    const stateRoot = await tempRoot("rcmcp-rc25-jobs-");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(stateRoot, "jobs"), { recursive: true }));
    vi.stubEnv("RCMCP_STATE_DIR", stateRoot);
    const release = path.join(stateRoot, "release"), script = path.join(stateRoot, "RC25_FAIL.cjs");
    await writeFile(script, `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer)}},20);`);
    const command = nativeCommand([process.execPath, script]);
    const pids = new Set<number>();
    const stop = async () => {
      await writeFile(release, "go");
      await vi.waitFor(() => expect([...pids].some(processAlive)).toBe(false), { timeout: process.platform === "win32" ? 15_000 : 5000 });
    };
    closers.push(stop);
    const termination = vi.fn(async (pid: number) => {
      pids.add(pid);
      // The fixture emits controlled verification receipts; even its verified
      // branch waits for the real runner to stop before allowing artifact removal.
      if (options.terminate === "verified") await stop();
      if (options.terminate === "throw") throw new Error("RC25 termination fixture failed");
      return { terminated: options.terminate === "verified", forced: false, reason: options.terminate === "verified" ? undefined : "RC25 termination was not verified" };
    });
    vi.doMock("../apps/agent/src/process-identity.ts", async (importOriginal) => ({
      ...await importOriginal<typeof import("../apps/agent/src/process-identity.ts")>(),
      terminateVerifiedProcessTreeDetailedAsync: termination,
    }));
    vi.doMock("../apps/agent/src/state.ts", async (importOriginal) => {
      const original = await importOriginal<typeof import("../apps/agent/src/state.ts")>();
      return {
        ...original,
        atomicWriteJson: (target: string, value: unknown) => {
          if (typeof value === "object" && value !== null && "command" in value && String((value as { command: unknown }).command).includes("RC25_FAIL")) {
            if (options.publishThenThrow) original.atomicWriteJson(target, value);
            throw Object.assign(new Error("RC25 metadata persistence failed"), { code: "ENOSPC" });
          }
          return original.atomicWriteJson(target, value);
        },
      };
    });
    const jobs = await import("../apps/agent/src/jobs.ts");
    return { jobs, stateRoot, termination, command };
  }

  it("cleans all artifacts only after verified termination", async () => {
    const { jobs, stateRoot, termination, command } = await mockedJobs({ terminate: "verified" });
    await expect(jobs.jobStart({ command })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(termination).toHaveBeenCalledTimes(1);
    const files = await readdir(path.join(stateRoot, "jobs"));
    expect(files.filter((name) => /\.(json|stdout\.log|stderr\.log|exit|progress)$/.test(name))).toEqual([]);
  }, 40_000);

  it("retains logs and structured uncertain-process recovery when termination is false or throws", async () => {
    for (const terminate of ["unverified", "throw"] as const) {
      vi.resetModules();
      const { jobs, stateRoot, termination, command } = await mockedJobs({ terminate });
      let failure: any;
      try { await jobs.jobStart({ command }); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: "JobRecoveryError", jobId: expect.any(String), pid: expect.any(Number), processStatus: "uncertain", stdoutPath: expect.stringContaining(".stdout.log"), stderrPath: expect.stringContaining(".stderr.log"), marker: expect.stringContaining("RCMCP_JOB_ID=") });
      expect(failure.metadataPath).toContain(`${failure.jobId}.json`);
      expect(termination).toHaveBeenCalledTimes(1);
      const files = await readdir(path.join(stateRoot, "jobs"));
      expect(files).toEqual(expect.arrayContaining([`${failure.jobId}.stdout.log`, `${failure.jobId}.stderr.log`]))
      // A storage failure may also prevent the best-effort recovery journal;
      // the in-memory error and retained logs remain the recovery receipt.
      expect(files).not.toContain(`${failure.jobId}.json`);
    }
  }, 40_000);

  it("retains publication evidence and supports restart inspection after a post-publication failure", async () => {
    const { jobs, stateRoot, command } = await mockedJobs({ terminate: "unverified", publishThenThrow: true });
    let failure: any;
    try { await jobs.jobStart({ command }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: "JobRecoveryError", processStatus: "uncertain" });
    expect(existsSync(failure.metadataPath)).toBe(true);
    vi.doUnmock("../apps/agent/src/state.ts");
    vi.resetModules();
    const restarted = await import("../apps/agent/src/jobs.ts");
    expect(await restarted.jobStatusAsync(failure.jobId)).toMatchObject({ id: failure.jobId, pid: failure.pid });
    expect(await readdir(path.join(stateRoot, "jobs"))).toEqual(expect.arrayContaining([`${failure.jobId}.stdout.log`, `${failure.jobId}.stderr.log`]))
  }, 40_000);
});

describe("RC25-03 cancellable filesystem copy", () => {
  it("returns a no-effect receipt for pre-abort and a partial receipt for between-file abort", async () => {
    const root = await tempRoot("rcmcp-rc25-copy-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination", "tree");
    await (await import("node:fs/promises")).mkdir(source);
    await writeFile(path.join(source, "a.txt"), "A");
    await writeFile(path.join(source, "b.txt"), "B");

    const preabort = await fsManage({ operation: "copy", path: source, destination }, AbortSignal.abort(new Error("pre-abort")));
    expect(preabort).toMatchObject({ copied: 0, skipped: 0, cancelled: true, timedOut: false });
    expect(existsSync(destination)).toBe(false);

    const partialSignal = {
      get aborted() { return existsSync(path.join(destination, "a.txt")); },
      throwIfAborted() { if (existsSync(path.join(destination, "a.txt"))) throw new DOMException("copy cancelled", "AbortError"); },
    } as unknown as AbortSignal;
    const partial = await fsManage({ operation: "copy", path: source, destination, force: true }, partialSignal);
    expect(partial).toMatchObject({ copied: 2, cancelled: true, timedOut: false, partialEffectsPossible: true });
    expect(await readFile(path.join(destination, "a.txt"), "utf8")).toBe("A");
    expect(existsSync(path.join(destination, "b.txt"))).toBe(false);
  });

  it("preserves no-clobber and symlink behavior while reporting timeout state", async () => {
    const root = await tempRoot("rcmcp-rc25-copy-flags-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await (await import("node:fs/promises")).mkdir(source);
    await writeFile(path.join(source, "same.txt"), "source");
    await writeFile(destination, "existing");
    const skipped = await fsManage({ operation: "copy", path: path.join(source, "same.txt"), destination, force: false });
    expect(skipped).toMatchObject({ copied: 0, skipped: 1, outcome: "skipped", reason: "destination_exists" });

    const timeoutDestination = path.join(root, "timeout-tree");
    const timeoutSignal = {
      reason: new DOMException("copy timed out", "TimeoutError"),
      get aborted() { return existsSync(path.join(timeoutDestination, "same.txt")); },
      throwIfAborted() { if (existsSync(path.join(timeoutDestination, "same.txt"))) throw new DOMException("copy timed out", "TimeoutError"); },
    } as unknown as AbortSignal;
    const timedOut = await fsManage({ operation: "copy", path: source, destination: timeoutDestination, force: true }, timeoutSignal);
    expect(timedOut).toMatchObject({ cancelled: true, timedOut: true, partialEffectsPossible: true });
    expect((timedOut as { copied: number }).copied).toBeGreaterThanOrEqual(2);
  });
  it("copies symlinks when native creation privileges are available", async (context) => {
    const root = await tempRoot("rcmcp-rc25-copy-link-");
    const source = path.join(root, "source");
    await (await import("node:fs/promises")).mkdir(source);
    await writeFile(path.join(source, "same.txt"), "source");
    const link = path.join(source, "link");
    try { await (await import("node:fs/promises")).symlink("same.txt", link); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip("Windows symlink creation privilege is unavailable"); return;
      }
      throw error;
    }
    const linkedDestination = path.join(root, "linked");
    const controller = new AbortController();
    const result = await fsManage({ operation: "copy", path: link, destination: linkedDestination, force: false }, controller.signal);
    expect(result).toMatchObject({ copied: 1, cancelled: false, timedOut: false });
    expect((await (await import("node:fs/promises")).lstat(linkedDestination)).isSymbolicLink()).toBe(true);
    expect(await (await import("node:fs/promises")).readlink(linkedDestination)).toBe("same.txt");
  }, 30_000);

});

it("cancels an SDK job_wait without stopping or replaying its durable job", async () => {
  const root = await tempRoot("rc25-cancel-wait-"), ready = path.join(root, "ready"), release = path.join(root, "release"), effect = path.join(root, "effect");
  const script = path.join(root, "wait.cjs");
  await writeFile(script, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){fs.appendFileSync(${JSON.stringify(effect)},'once');clearInterval(timer)}},20);`);
  const agent = Fastify(); registerExtraRoutes(agent);
  let followStarted!: () => void;
  const entered = new Promise<void>(resolve => { followStarted = resolve; });
  agent.addHook("preHandler", async (request) => { if (request.url === "/v1/jobs/follow") followStarted(); });
  const url = await agent.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => agent.close());
  const mcp = new (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer({ name: "wait", version: "1" });
  const agentClient = new AgentClient([{ name: "fixture", url }]); registerJobTools(mcp, agentClient);
  const sdk = new Client({ name: "wait-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair(); await Promise.all([mcp.connect(left), sdk.connect(right)]);
  closers.push(async () => { await sdk.close(); await mcp.close(); });
  const jobs = await import("../apps/agent/src/jobs.ts");
  const job = await jobs.jobStart({ command: nativeCommand([process.execPath, script]), cwd: root });
  const controller = new AbortController();
  try {
    await waitForFile(ready);
    const wait = sdk.callTool({ name: "job_wait", arguments: { device: "fixture", id: job.id, waitMs: 30_000 } }, undefined, { signal: controller.signal });
    void wait.catch(() => undefined);
    await entered; controller.abort();
    await expect(wait).rejects.toThrow();
    expect(await jobs.jobStatusAsync(job.id)).toMatchObject({ state: "running" });
    expect(existsSync(effect)).toBe(false);
    await writeFile(release, "go");
    await vi.waitFor(async () => expect(await jobs.jobStatusAsync(job.id)).toMatchObject({ state: "completed", exitCode: 0 }), { timeout: 5000 });
    expect(await readFile(effect, "utf8")).toBe("once");
  } finally { controller.abort(); await writeFile(release, "cleanup"); await jobs.jobRemove(job.id, true); }
}, 40_000);
