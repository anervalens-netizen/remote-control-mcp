import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let cancelTimer = () => {};
  try {
    const timeout = new Promise<undefined>(resolve => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      cancelTimer = () => clearTimeout(timer);
    });
    return await Promise.race([promise, timeout]);
  } finally { cancelTimer(); }
}
async function liveIdentity(
  pid: number,
  readStat: (file: string, encoding: "utf8") => Promise<string> = readFile,
): Promise<string | undefined> {
  try {
    const stat = await readStat(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[0] === "Z" || fields[0] === "X" ? undefined : `${pid}:${fields[19]}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
}

it.each(["ENOENT", "ESRCH"])("treats procfs %s as a vanished process", async code => {
  const error = Object.assign(new Error("synthetic procfs read failure"), { code });
  await expect(liveIdentity(12345, async () => { throw error; })).resolves.toBeUndefined();
});

it.each(["EACCES", "EIO"])("preserves unexpected procfs %s errors", async code => {
  const error = Object.assign(new Error("synthetic procfs read failure"), { code });
  await expect(liveIdentity(12345, async () => { throw error; })).rejects.toBe(error);
});

it.skipIf(process.platform !== "linux").each(["SIGTERM", "SIGINT"] as const)(
  "exits the real agent by %s after cleanup with an attached live PTY", async signal => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-pty-shutdown-"));
    const token = randomUUID();
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
    Object.assign(env, { HOME: root, ENV: "/dev/null", BASH_ENV: "/dev/null", HISTFILE: "/dev/null",
      RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: String(port), RCMCP_AGENT_TOKEN: token,
      RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_DESKTOP_ENABLED: "0", RCMCP_JOB_CGROUP_ISOLATION: "0" });
    const child = spawn(process.execPath, [path.resolve("apps/agent/src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    const childIdentity = await liveIdentity(child.pid!);
    let logs = "";
    child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
    child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
    let terminal: { id: string; pid: number; state: string } | undefined;
    let terminalIdentity: string | undefined;
    const base = `http://127.0.0.1:${port}`;
    const call = (route: string, body?: unknown) => fetch(base + route, {
      method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1000),
    });
    try {
      let ready = false;
      const bootDeadline = Date.now() + 10000;
      while (Date.now() < bootDeadline && child.exitCode === null && child.signalCode === null) {
        try {
          const response = await call("/v1/info");
          const info = await response.json() as { runtime?: { pid?: number } };
          if (response.ok && info.runtime?.pid === child.pid) { ready = true; break; }
        } catch { /* Wait for this isolated agent only. */ }
        await pause(25);
      }
      expect(ready, logs).toBe(true);
      const response = await call("/v1/pty/start", { shell: "/bin/sh", cwd: root, env: { HOME: root, ENV: "/dev/null", HISTFILE: "/dev/null" } });
      expect(response.status).toBe(200);
      terminal = await response.json() as typeof terminal;
      expect(terminal).toMatchObject({ state: "running" });
      terminalIdentity = await liveIdentity(terminal!.pid);
      expect(terminalIdentity).toBeDefined();
      const terminalEnvironment = await readFile(`/proc/${terminal!.pid}/environ`, "utf8");
      expect(terminalEnvironment.split("\0").includes("RCMCP_PTY_SESSION_ID=" + terminal!.id)).toBe(true);

      child.kill(signal);
      const exit = await within(closed, 3000);
      const terminalDeadline = Date.now() + 1000;
      while (await liveIdentity(terminal!.pid) === terminalIdentity && Date.now() < terminalDeadline) await pause(10);
      const aggregate = path.join(root, "state", "agent-ingress-v1", "aggregate.json");
      const saved = JSON.parse(await readFile(aggregate, "utf8"));
      const claimPresent = await readFile(aggregate + ".writer").then(() => true, error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      const observed = {
        agentExited: exit !== undefined, exitCode: exit?.[0] ?? null, exitSignal: exit?.[1] ?? null,
        originalPtyAlive: await liveIdentity(terminal!.pid) === terminalIdentity,
        cleanShutdown: saved.cleanShutdown, previousUnfinished: saved.previousUnfinished, claimPresent,
      };
      expect(observed).toEqual({ agentExited: true, exitCode: null, exitSignal: signal,
        originalPtyAlive: false, cleanShutdown: true, previousUnfinished: 0, claimPresent: false });
    } finally {
      // Cleanup is limited to this child and the exact marked PTY identity.
      if (childIdentity && await liveIdentity(child.pid!) === childIdentity) child.kill("SIGKILL");
      expect(await within(closed, 5000)).toBeDefined();
      if (terminal && terminalIdentity && await liveIdentity(terminal.pid) === terminalIdentity) {
        const environment = await readFile(`/proc/${terminal.pid}/environ`, "utf8");
        expect(environment.split("\0").includes("RCMCP_PTY_SESSION_ID=" + terminal.id)).toBe(true);
        if (await liveIdentity(terminal.pid) === terminalIdentity) process.kill(terminal.pid, "SIGKILL");
      }
      if (terminal && terminalIdentity) {
        const deadline = Date.now() + 2000;
        while (await liveIdentity(terminal.pid) === terminalIdentity && Date.now() < deadline) await pause(10);
        expect(await liveIdentity(terminal.pid)).not.toBe(terminalIdentity);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 20000,
);
