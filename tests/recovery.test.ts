import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const originalStateDir = process.env.RCMCP_STATE_DIR;
const originalRgPath = process.env.RCMCP_RG_PATH;

afterEach(async () => {
  vi.doUnmock("../apps/agent/src/state.ts");
  vi.doUnmock("../apps/agent/src/process-identity.ts");
  vi.resetModules();
  if (originalStateDir === undefined) delete process.env.RCMCP_STATE_DIR;
  else process.env.RCMCP_STATE_DIR = originalStateDir;
  if (originalRgPath === undefined) delete process.env.RCMCP_RG_PATH;
  else process.env.RCMCP_RG_PATH = originalRgPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function isolatedRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  process.env.RCMCP_STATE_DIR = root;
  vi.resetModules();
  return root;
}

async function waitPty(mod: typeof import("../apps/agent/src/pty.ts"), id: string, marker: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const page = mod.ptyOutput(id, 0, 1024 * 1024);
    if (page.data.includes(marker)) return page;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PTY marker not found: ${marker}`);
}

async function waitSearch(mod: typeof import("../apps/agent/src/search-sessions.ts"), id: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const page = mod.searchResults(id, 0, 1000);
    if (page.status !== "running") return page;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Search ${id} did not finish`);
}

describe("restart recovery", () => {

  it.runIf(process.platform !== "win32")("does not resurrect search metadata removed while startup identity is pending", async () => {
    const root = await isolatedRoot("rcmcp-search-remove-start-");
    const fakeRg = path.join(root, "fake-rg.sh");
    await writeFile(fakeRg, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexec sleep 5\n');
    await chmod(fakeRg, 0o700); process.env.RCMCP_RG_PATH = fakeRg;
    let release!: () => void;
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return { ...actual, currentProcessIdentityAsync: (pid: number) => {
        const identity = actual.currentProcessIdentity(pid);
        return new Promise<string | null>(resolve => { release = () => resolve(identity); });
      }};
    });
    const mod = await import("../apps/agent/src/search-sessions.ts");
    const pending = mod.searchStart({ path: root, pattern: "needle", literal: true }).then(value => value, error => error);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const id = mod.searchSessions()[0]!.id;
    await mod.searchRemove(id, true);
    release(); await pending;
    expect((await readdir(path.join(root, "search"))).filter(name => name.endsWith(".json"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")("does not resurrect exited PTY metadata removed while startup identity is pending", async () => {
    const root = await isolatedRoot("rcmcp-pty-remove-start-");
    let release!: () => void;
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return { ...actual, currentProcessIdentityAsync: (pid: number) => {
        const identity = actual.currentProcessIdentity(pid);
        return new Promise<string | null>(resolve => { release = () => resolve(identity); });
      }};
    });
    const mod = await import("../apps/agent/src/pty.ts");
    const pending = mod.ptyStart({ shell: "/bin/bash" }).then(value => value, error => error);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const id = mod.ptyList()[0]!.id;
    mod.ptyInput(id, "exit\n");
    await vi.waitFor(() => expect(mod.ptyOutput(id).exited).toBe(true));
    await mod.ptyRemove(id);
    release(); await pending;
    expect((await readdir(path.join(root, "pty"))).filter(name => name.endsWith(".json"))).toEqual([]);
  });

  it("keeps the PTY start pending while an async identity probe is delayed and persists identity before success", async () => {
    const root = await isolatedRoot("rcmcp-startup-pty-identity-");
    let release!: (identity: string | null) => void;
    let probeStarted = false;
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return {
        ...actual,
        currentProcessIdentityAsync: (pid: number) => new Promise<string | null>((resolve) => {
          probeStarted = true;
          release = (identity) => resolve(identity ?? actual.currentProcessIdentity(pid));
        }),
      };
    });
    const mod = await import("../apps/agent/src/pty.ts");
    let startSettled = false;
    const pending = mod.ptyStart({ shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash" }).then(value => { startSettled = true; return value; });
    await vi.waitFor(() => expect(probeStarted).toBe(true));
    expect(startSettled).toBe(false);
    const listedBefore = mod.ptyList().find((item) => item.id);
    expect(listedBefore?.state).toBe("running");
    const beforeMeta = JSON.parse(await readFile(path.join(root, "pty", `${listedBefore!.id}.json`), "utf8")) as Record<string, unknown>;
    expect(beforeMeta.processIdentity).toBeUndefined();
    expect(mod.ptyList()).toHaveLength(1);

    release(null);
    const session = await pending;
    const afterMeta = JSON.parse(await readFile(path.join(root, "pty", `${session.id}.json`), "utf8")) as Record<string, unknown>;
    expect(afterMeta.processIdentity).toEqual(expect.any(String));
    await mod.ptyRemove(session.id, true);
  }, 10_000);

  it("fails a PTY start honestly when identity probing fails and removes the unsafe running record", async () => {
    await isolatedRoot("rcmcp-startup-pty-probe-fail-");
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return { ...actual, currentProcessIdentityAsync: async () => null };
    });
    const mod = await import("../apps/agent/src/pty.ts");
    await expect(mod.ptyStart({ shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash" })).rejects.toThrow(/process identity could not be established/);
    expect(mod.ptyList()).toMatchObject([{ state: "lost", recoveryReason: "pty_process_identity_unavailable" }]);
  }, 10_000);

  it.runIf(process.platform !== "win32")("does not return a search start until delayed identity is durable while heartbeat reads remain responsive", async () => {
    const root = await isolatedRoot("rcmcp-startup-search-identity-");
    const fakeRg = path.join(root, "fake-rg.sh");
    await writeFile(fakeRg, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nexec sleep 5\n");
    await chmod(fakeRg, 0o700);
    process.env.RCMCP_RG_PATH = fakeRg;
    let release!: (identity: string | null) => void;
    let probeStarted = false;
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return {
        ...actual,
        currentProcessIdentityAsync: (pid: number) => new Promise<string | null>((resolve) => {
          probeStarted = true;
          release = (identity) => resolve(identity ?? actual.currentProcessIdentity(pid));
        }),
      };
    });
    const mod = await import("../apps/agent/src/search-sessions.ts");
    let startSettled = false;
    const pending = mod.searchStart({ path: root, pattern: "needle", literal: true }).then(value => { startSettled = true; return value; });
    await vi.waitFor(() => expect(probeStarted).toBe(true));
    expect(startSettled).toBe(false);
    const listedBefore = mod.searchSessions().find((item) => item.status === "running");
    expect(listedBefore).toBeTruthy();
    const beforeMeta = JSON.parse(await readFile(path.join(root, "search", `${listedBefore!.id}.json`), "utf8")) as Record<string, unknown>;
    expect(beforeMeta.processIdentity).toBeUndefined();
    expect(mod.searchSessions()).toHaveLength(1);

    release(null);
    const started = await pending;
    const afterMeta = JSON.parse(await readFile(path.join(root, "search", `${started.id}.json`), "utf8")) as Record<string, unknown>;
    expect(afterMeta.processIdentity).toEqual(expect.any(String));
    await mod.searchRemove(started.id, true);
  }, 10_000);

  it.runIf(process.platform !== "win32")("cleans up a search when identity metadata persistence fails after registration", async () => {
    const root = await isolatedRoot("rcmcp-startup-search-persist-fail-");
    const fakeRg = path.join(root, "fake-rg.sh");
    await writeFile(fakeRg, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exit 0; fi\nexec sleep 5\n");
    await chmod(fakeRg, 0o700);
    process.env.RCMCP_RG_PATH = fakeRg;
    let writes = 0;
    vi.doMock("../apps/agent/src/state.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/state.ts")>("../apps/agent/src/state.ts");
      return { ...actual, atomicWriteJson: (file: string, value: unknown) => { writes += 1; if (writes > 1) throw new Error("simulated identity persistence failure"); return actual.atomicWriteJson(file, value); } };
    });
    const mod = await import("../apps/agent/src/search-sessions.ts");
    await expect(mod.searchStart({ path: root, pattern: "needle", literal: true })).rejects.toThrow("simulated identity persistence failure");
    expect(mod.searchSessions()).toEqual([]);
    expect((await readdir(path.join(root, "search"))).filter((name) => name.endsWith(".json"))).toEqual([]);
  }, 10_000);

  it("keeps PTY output on disk and marks an unreattachable pre-restart session lost", async () => {
    const root = await isolatedRoot("rcmcp-recovery-pty-");
    const first = await import("../apps/agent/src/pty.ts");
    const session = await first.ptyStart({ ...(process.platform === "win32" ? {} : { shell: "/bin/bash" }) });
    first.ptyInput(session.id, process.platform === "win32" ? "Write-Output RECOVERY_MARKER\r" : "echo RECOVERY_MARKER\n");
    await waitPty(first, session.id, "RECOVERY_MARKER");
    await first.ptyTerminate(session.id);

    const file = path.join(root, "pty", `${session.id}.json`);
    const meta = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    meta.state = "running";
    delete meta.finishedAt;
    await writeFile(file, `${JSON.stringify(meta)}\n`);

    vi.resetModules();
    const second = await import("../apps/agent/src/pty.ts");
    const listed = second.ptyList().find((item) => item.id === session.id);
    expect(listed).toMatchObject({
      state: "lost", exited: false, terminationVerified: false,
      recoveryReason: process.platform === "win32" ? "agent_restarted_session_termination_unverified" : "agent_restarted_session_not_reattachable",
    });
    const recoveredOutput = second.ptyOutput(session.id, 0, 1024 * 1024);
    expect(recoveredOutput).toMatchObject({ state: "lost", exited: false, terminationVerified: false });
    expect(recoveredOutput.data).toContain("RECOVERY_MARKER");
    await expect(second.ptyTerminate(session.id)).resolves.toMatchObject({
      state: "lost", exited: false, alreadyExited: false, terminationVerified: false,
      recoveryReason: process.platform === "win32" ? "agent_restarted_session_termination_unverified" : "agent_restarted_session_not_reattachable",
    });
    await second.ptyRemove(session.id);
  }, 15_000);

  it.skipIf(process.platform === "win32")("stops a PTY and reports lost when output persistence fails", async () => {
    const root = await isolatedRoot("rcmcp-recovery-pty-output-fail-");
    const mod = await import("../apps/agent/src/pty.ts");
    const session = await mod.ptyStart({ shell: "/bin/cat" });
    const output = path.join(root, "pty", session.id + ".out.log");
    await rm(output, { force: true });
    await mkdir(output);

    mod.ptyInput(session.id, "printf 'OUTPUT_PERSIST_FAIL\\n'; sleep 5\n");
    const deadline = Date.now() + 3000;
    let listed = mod.ptyList().find((item) => item.id === session.id);
    while (listed?.state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      listed = mod.ptyList().find((item) => item.id === session.id);
    }
    expect(listed).toMatchObject({ state: "lost", exited: false, recoveryReason: "pty_output_persistence_failed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(session.pid, 0)).toThrow();

    await rm(output, { recursive: true, force: true });
    await writeFile(output, "");
    await mod.ptyRemove(session.id);
  });

  it.skipIf(process.platform === "win32")("contains terminal metadata persistence failure without crashing the agent", async () => {
    const root = await isolatedRoot("rcmcp-recovery-pty-meta-fail-");
    const mod = await import("../apps/agent/src/pty.ts");
    const session = await mod.ptyStart({ shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash" });
    const metadata = path.join(root, "pty", session.id + ".json");
    await rm(metadata, { force: true });
    await mkdir(metadata);

    mod.ptyInput(session.id, "exit 0\n");
    const deadline = Date.now() + 3000;
    let listed: ReturnType<typeof mod.ptyList>[number] | undefined;
    while (Date.now() < deadline) {
      try {
        listed = mod.ptyList().find((item) => item.id === session.id);
        if (listed?.state !== "running") break;
      } catch {
        // Until onExit installs the volatile fallback, the injected directory is intentionally unreadable as JSON.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(listed).toMatchObject({
      state: "lost",
      exited: false,
      recoveryReason: "pty_terminal_metadata_persistence_failed",
    });

    await rm(metadata, { recursive: true, force: true });
    await mod.ptyRemove(session.id);
  });

  it.skipIf(process.platform === "win32")("stops a verified PTY survivor during restart recovery", async () => {
    const root = await isolatedRoot("rcmcp-recovery-pty-orphan-");
    const ptyRoot = path.join(root, "pty");
    await mkdir(ptyRoot, { recursive: true });
    const id = "verified-pty-orphan";
    const outputPath = path.join(ptyRoot, id + ".out.log");
    await writeFile(outputPath, "SURVIVOR_OUTPUT\n");

    const child = spawn("/bin/bash", ["-lc", "trap '' TERM; (trap '' TERM; sleep 20) & wait"], { stdio: "ignore", detached: true });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("missing PTY orphan PID");
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      const { currentProcessIdentity } = await import("../apps/agent/src/process-identity.ts");
      const createdAt = new Date().toISOString();
      const processIdentity = currentProcessIdentity(child.pid);
      expect(processIdentity).toBeTruthy();
      await writeFile(path.join(ptyRoot, id + ".json"), JSON.stringify({
        id,
        pid: child.pid,
        shell: "/bin/sleep",
        cwd: root,
        cols: 80,
        rows: 24,
        state: "running",
        createdAt,
        updatedAt: createdAt,
        outputPath,
        processIdentity,
        ownerInstanceId: "old-agent",
      }) + "\n");

      vi.resetModules();
      const recoveredModule = await import("../apps/agent/src/pty.ts");
      const listed = recoveredModule.ptyList().find((item) => item.id === id);
      expect(listed).toMatchObject({
        state: "lost",
        exited: false,
        terminationVerified: false,
        recoveryReason: "agent_restarted_session_survivor_stopped",
      });
      await Promise.race([
        childClosed,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("PTY survivor remained alive")), 2000)),
      ]);
      expect(() => process.kill(child.pid!, 0)).toThrow();
      expect(() => process.kill(-child.pid!, 0)).toThrow();
      expect(recoveredModule.ptyOutput(id, 0, 1024).data).toContain("SURVIVOR_OUTPUT");
      await recoveredModule.ptyRemove(id);
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { try { process.kill(child.pid!, "SIGKILL"); } catch { /* already stopped */ } }
    }
  });

  it("keeps search results on disk and recovers an interrupted search as lost", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-");
    const dataRoot = path.join(root, "data");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, "needle.txt"), "needle\n");
    const first = await import("../apps/agent/src/search-sessions.ts");
    const started = await first.searchStart({ path: dataRoot, pattern: "needle", literal: true, maxResults: 10 });
    const done = await waitSearch(first, started.id);
    expect(done.results).toHaveLength(1);

    const file = path.join(root, "search", `${started.id}.json`);
    const meta = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    meta.status = "running";
    delete meta.finishedAt;
    await writeFile(file, `${JSON.stringify(meta)}\n`);

    vi.resetModules();
    const second = await import("../apps/agent/src/search-sessions.ts");
    const recovered = second.searchResults(started.id, 0, 10);
    expect(recovered).toMatchObject({ status: "lost", available: 1, recoveryReason: process.platform === "win32" ? "agent_restarted_search_termination_unverified" : "agent_restarted_search_not_reattachable" });
    expect(recovered.results).toHaveLength(1);
    await second.searchRemove(started.id);
  });

  it.skipIf(process.platform === "win32")("stops a verified orphaned search process during restart recovery", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-orphan-");
    const searchRoot = path.join(root, "search");
    await mkdir(searchRoot, { recursive: true });
    const id = "verified-orphan";
    const resultsPath = path.join(searchRoot, id + ".results.jsonl");
    const stderrPath = path.join(searchRoot, id + ".stderr.log");
    await writeFile(resultsPath, "");
    await writeFile(stderrPath, "");

    const child = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("missing orphan PID");
    const { currentProcessIdentity } = await import("../apps/agent/src/process-identity.ts");
    const createdAt = new Date().toISOString();
    const processIdentity = currentProcessIdentity(child.pid);
    expect(processIdentity).toBeTruthy();
    await writeFile(path.join(searchRoot, id + ".json"), JSON.stringify({
      id,
      input: { path: root, pattern: "never" },
      status: "running",
      createdAt,
      updatedAt: createdAt,
      resultsPath,
      stderrPath,
      resultsCount: 0,
      limited: false,
      root,
      pid: child.pid,
      processIdentity,
      exitCode: null,
      ownerInstanceId: "old-agent",
    }) + "\n");

    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    vi.resetModules();
    const recoveredModule = await import("../apps/agent/src/search-sessions.ts");
    const recovered = recoveredModule.searchResults(id, 0, 10);
    expect(recovered).toMatchObject({ status: "lost", recoveryReason: "agent_restarted_search_orphan_stopped" });
    await Promise.race([childClosed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("orphan survived recovery")), 2000))]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
    await recoveredModule.searchRemove(id);
  });

  it("terminates a spawned search if initial metadata registration fails", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-register-fail-");
    const stop = vi.fn((pid: number) => {
      try { process.kill(pid, "SIGKILL"); } catch { /* child may already have exited */ }
      return true;
    });
    vi.doMock("../apps/agent/src/state.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/state.ts")>("../apps/agent/src/state.ts");
      return { ...actual, atomicWriteJson: () => { throw new Error("simulated metadata registration failure"); } };
    });
    vi.doMock("../apps/agent/src/process-identity.ts", async () => {
      const actual = await vi.importActual<typeof import("../apps/agent/src/process-identity.ts")>("../apps/agent/src/process-identity.ts");
      return { ...actual, currentProcessIdentity: () => "test-process-identity", currentProcessIdentityAsync: async () => "test-process-identity", terminateVerifiedProcess: stop, terminateVerifiedProcessTreeDetailedAsync: async (pid: number) => { stop(pid); return {terminated:true,forced:true}; } };
    });

    const mod = await import("../apps/agent/src/search-sessions.ts");
    await expect(mod.searchStart({ path: root, pattern: "needle", literal: true })).rejects.toThrow("simulated metadata registration failure");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    const names = await readdir(path.join(root, "search"));
    expect(names.filter((name) => name.endsWith(".json") || name.endsWith(".results.jsonl") || name.endsWith(".stderr.log"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("contains stderr persistence failure inside the search lifecycle", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-stderr-fail-");
    const fakeRg = path.join(root, "fake-rg.sh");
    // Runtime discovery invokes --version during import. It must not enter
    // the deliberately slow stderr-emitting search fixture.
    await writeFile(fakeRg, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'ripgrep test-fixture\\n'
  exit 0
fi
sleep 0.2
printf 'FAKE_STDERR\\n' >&2
exec sleep 5
`);
    await chmod(fakeRg, 0o700);
    process.env.RCMCP_RG_PATH = fakeRg;
    vi.resetModules();
    const mod = await import("../apps/agent/src/search-sessions.ts");
    const started = await mod.searchStart({ path: root, pattern: "needle", literal: true });
    const errorFile = path.join(root, "search", started.id + ".stderr.log");
    await rm(errorFile, { force: true });
    await mkdir(errorFile);

    const deadline = Date.now() + 3000;
    let finished = mod.searchResults(started.id, 0, 10);
    while (finished.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      finished = mod.searchResults(started.id, 0, 10);
    }
    expect(finished.status).toBe("error");
    expect(finished.error).toContain("Search stderr persistence failed:");
    expect(mod.searchSessions().find((item) => item.id === started.id)).toMatchObject({ status: "error" });

    await rm(errorFile, { recursive: true, force: true });
    await writeFile(errorFile, "");
    await mod.searchRemove(started.id, true);
  });

  it("ignores a torn final JSONL record while preserving complete recovered search results", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-tail-");
    const searchRoot = path.join(root, "search");
    await mkdir(searchRoot, { recursive: true });
    const id = "torn-tail";
    const resultFile = path.join(searchRoot, id + ".results.jsonl");
    const errorFile = path.join(searchRoot, id + ".stderr.log");
    const durable = { path: path.join(root, "needle.txt"), line: 1, column: 1, text: "needle" };
    await writeFile(resultFile, JSON.stringify(durable) + "\n" + '{"path":"torn');
    await writeFile(errorFile, "");
    const now = new Date().toISOString();
    await writeFile(path.join(searchRoot, id + ".json"), JSON.stringify({
      id,
      input: { path: root, pattern: "needle", literal: true },
      status: "done",
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      resultsPath: resultFile,
      stderrPath: errorFile,
      resultsCount: 2,
      limited: false,
      root,
      pid: null,
      exitCode: 0,
      ownerInstanceId: "old-agent",
    }) + "\n");

    vi.resetModules();
    const recoveredModule = await import("../apps/agent/src/search-sessions.ts");
    const recovered = recoveredModule.searchResults(id, 0, 10);
    expect(recovered).toMatchObject({ status: "done", available: 1 });
    expect(recovered.results).toEqual([durable]);
    await recoveredModule.searchRemove(id);
  });

  it("reconciles terminal search metadata to durable JSONL results after restart", async () => {
    const root = await isolatedRoot("rcmcp-recovery-search-terminal-");
    const dataRoot = path.join(root, "data-terminal");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, "needle.txt"), "needle\n");
    const first = await import("../apps/agent/src/search-sessions.ts");
    const started = await first.searchStart({ path: dataRoot, pattern: "needle", literal: true, maxResults: 10 });
    const done = await waitSearch(first, started.id);
    expect(done).toMatchObject({ status: "done", available: 1 });
    const resultFile = path.join(root, "search", `${started.id}.results.jsonl`);
    await writeFile(resultFile, "");

    vi.resetModules();
    const second = await import("../apps/agent/src/search-sessions.ts");
    const recovered = second.searchResults(started.id, 0, 10);
    expect(recovered).toMatchObject({ status: "done", available: 0 });
    expect(recovered.results).toEqual([]);
    await second.searchRemove(started.id);
  });

  it("waits briefly for a durable exit marker after a verified process disappears", async () => {
    const root = await isolatedRoot("rcmcp-recovery-marker-grace-");
    const jobs = path.join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    const id = "marker-grace";
    const stdoutPath = path.join(jobs, `${id}.stdout.log`);
    const stderrPath = path.join(jobs, `${id}.stderr.log`);
    const exitPath = path.join(jobs, `${id}.exit`);
    await writeFile(stdoutPath, "");
    await writeFile(stderrPath, "");
    await writeFile(path.join(jobs, `${id}.json`), `${JSON.stringify({
      id, command: "finished", cwd: null, pid: 2147483647, state: "running",
      startedAt: new Date().toISOString(), stdoutPath, stderrPath, exitPath,
      processIdentity: "verified-before-exit", ownerInstanceId: "old-agent",
    })}\n`);

    const mod = await import("../apps/agent/src/jobs.ts");
    const waiting = await mod.jobStatusAsync(id);
    expect(waiting).toMatchObject({ state: "running", recoveryReason: "process_gone_waiting_for_exit_marker" });

    await writeFile(exitPath, "0\n");
    const completed = await mod.jobStatusAsync(id);
    expect(completed).toMatchObject({ state: "completed", exitCode: 0 });
    expect(completed.recoveryReason).toBeUndefined();
    await mod.jobRemove(id);
  });

  it("waits for a durable exit marker when the runner PID has already been reused", async () => {
    const root = await isolatedRoot("rcmcp-recovery-reused-pid-marker-");
    const jobs = path.join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    const id = "reused-pid-marker";
    const stdoutPath = path.join(jobs, id + ".stdout.log");
    const stderrPath = path.join(jobs, id + ".stderr.log");
    const exitPath = path.join(jobs, id + ".exit");
    await writeFile(stdoutPath, "finished-output\n");
    await writeFile(stderrPath, "");
    await writeFile(path.join(jobs, id + ".json"), JSON.stringify({
      id, command: "finished", cwd: null, pid: process.pid, state: "running",
      startedAt: new Date().toISOString(), stdoutPath, stderrPath, exitPath,
      processIdentity: "definitely-not-this-process", ownerInstanceId: "old-agent",
    }) + "\n");

    const mod = await import("../apps/agent/src/jobs.ts");
    const waiting = await mod.jobStatusAsync(id);
    expect(waiting).toMatchObject({
      state: "running",
      recoveryReason: "process_identity_mismatch_waiting_for_exit_marker",
    });
    // This assertion is about a cancellation inside the 1500ms grace window,
    // not how long a hosted Windows identity probe takes to cold-start.
    const graceClock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(waiting.processGoneObservedAt!));
    try {
      const cancelAttempt = await mod.jobCancel(id);
      expect(cancelAttempt).toMatchObject({
        state: "running",
        recoveryReason: "process_identity_mismatch_waiting_for_exit_marker",
      });
    } finally { graceClock.mockRestore(); }
    expect(() => process.kill(process.pid, 0)).not.toThrow();

    await writeFile(exitPath, "0\n");
    const completed = await mod.jobStatusAsync(id);
    expect(completed).toMatchObject({ state: "completed", exitCode: 0 });
    expect(completed.recoveryReason).toBeUndefined();
    expect(mod.jobOutput({ id, stream: "stdout", offset: 0, length: 1024 }).data).toContain("finished-output");
    await mod.jobRemove(id);
  });

  it("does not trust a reused live PID when persisted process identity differs", async () => {
    const root = await isolatedRoot("rcmcp-recovery-job-");
    const jobs = path.join(root, "jobs");
    await mkdir(jobs, { recursive: true });
    const id = "stale-pid";
    const stdoutPath = path.join(jobs, `${id}.stdout.log`);
    const stderrPath = path.join(jobs, `${id}.stderr.log`);
    const exitPath = path.join(jobs, `${id}.exit`);
    await writeFile(stdoutPath, "");
    await writeFile(stderrPath, "");
    await writeFile(path.join(jobs, `${id}.json`), `${JSON.stringify({
      id, command: "stale", cwd: null, pid: process.pid, state: "running",
      startedAt: new Date().toISOString(), stdoutPath, stderrPath, exitPath,
      processIdentity: "definitely-not-this-process", ownerInstanceId: "old-agent",
      processGoneObservedAt: new Date(Date.now() - 3000).toISOString(),
      recoveryReason: "process_identity_mismatch_waiting_for_exit_marker",
    })}\n`);

    const mod = await import("../apps/agent/src/jobs.ts");
    const status = await mod.jobStatusAsync(id);
    expect(status).toMatchObject({ state: "lost", recoveryReason: "process_identity_no_longer_matches" });
    expect(() => process.kill(process.pid, 0)).not.toThrow();
    const leftovers = (await readdir(jobs)).filter((name) => name.startsWith(".rcmcp-state-"));
    expect(leftovers).toEqual([]);
    await mod.jobRemove(id);
  });
});
