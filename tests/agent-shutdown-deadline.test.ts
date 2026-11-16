import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let cancel = () => {};
  const timeout = new Promise<undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms); cancel = () => clearTimeout(timer);
  });
  try { return await Promise.race([promise, timeout]); } finally { cancel(); }
}
async function identity(pid: number): Promise<string | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    return ["Z", "X"].includes(fields[0]!) ? undefined : `${pid}:${fields[19]}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-shutdown-deadline-"));
  const token = randomUUID(), reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
  Object.assign(env, { HOME: root, ENV: "/dev/null", BASH_ENV: "/dev/null", HISTFILE: "/dev/null",
    RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: String(port), RCMCP_AGENT_TOKEN: token,
    RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_DESKTOP_ENABLED: "0", RCMCP_JOB_CGROUP_ISOLATION: "0" });
  const child = spawn(process.execPath, [path.resolve("apps/agent/src/index.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close"), clients: ClientRequest[] = [];
  let logs = "";
  child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error("Synthetic agent request failed: " + response.status);
    return response.json() as Promise<any>;
  };
  const open = (route: string, body: string, complete: boolean) => {
    const req = request(base + route, { method: "POST", headers: {
      authorization: "Bearer " + token, "content-type": "application/json", "content-length": Buffer.byteLength(body),
    } }, response => { response.on("error", () => {}); response.resume(); });
    clients.push(req); req.on("error", () => {});
    if (complete) req.end(body); else req.write(body.slice(0, 4));
    return req;
  };
  const cleanup = async () => {
    for (const req of clients) req.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    expect(await within(closed, 5000)).toBeDefined();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  try {
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { if ((await call("/v1/info")).runtime?.pid === child.pid) { ready = true; break; } } catch { /* isolated boot */ }
      await pause(25);
    }
    expect(ready, logs).toBe(true);
  } catch (error) { await cleanup(); throw error; }
  const aggregate = async () => {
    const file = path.join(root, "state", "agent-ingress-v1", "aggregate.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    const claimPresent = await readFile(file + ".writer").then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    return { saved, claimPresent };
  };
  return { root, child, closed, call, open, cleanup, aggregate };
}

it.skipIf(process.platform !== "linux").each([false, true])(
  "bounds shutdown of a real partial request body with repeated SIGTERM=%s", async repeated => {
    const agent = await fixture();
    try {
      agent.open("/v1/fs/read", JSON.stringify({ path: "/synthetic-not-dispatched", encoding: "base64" }), false);
      const admittedDeadline = Date.now() + 2000;
      let admitted = false;
      while (Date.now() < admittedDeadline) {
        const snapshot = await agent.call("/v1/observations/ingress", { sampleLimit: 0, seriesLimit: 0, historyLimit: 0 });
        if (snapshot.totals.inFlight >= 2) { admitted = true; break; }
        await pause(10);
      }
      expect(admitted).toBe(true);
      const started = performance.now();
      agent.child.kill("SIGTERM");
      if (repeated) { await pause(100); agent.child.kill("SIGTERM"); }
      const exit = await within(agent.closed, 10000);
      const { saved, claimPresent } = await agent.aggregate();
      expect({ exited: Boolean(exit), code: exit?.[0] ?? null, signal: exit?.[1] ?? null, claimPresent })
        .toEqual({ exited: true, code: 0, signal: null, claimPresent: false });
      expect(performance.now() - started).toBeLessThan(10000);
      const disconnected = saved.days.reduce((sum: number, row: { disconnected: number }) => sum + row.disconnected, 0);
      expect(disconnected + saved.previousUnfinished).toBeGreaterThanOrEqual(1);
      expect(saved.cleanShutdown).toBe(saved.previousUnfinished === 0);
      if (saved.previousUnfinished) expect(saved.faults).toContain("closed_with_inflight");
    } finally { await agent.cleanup(); }
  }, 20000,
);

it.skipIf(process.platform !== "linux")("drains cancellation of an owned foreground exec before exiting", async () => {
  const agent = await fixture();
  let owned: { pid: number; identity: string; marker: string } | undefined;
  try {
    const receipt = await agent.call("/v1/exec/prepare", {});
    const pidFile = path.join(agent.root, "foreground-pid");
    const code = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 30000);`;
    agent.open("/v1/exec", JSON.stringify({ command: "exec " + quote(process.execPath) + " -e " + quote(code),
      cwd: agent.root, timeoutMs: 60000, execReceiptId: receipt.id }), true);
    const deadline = Date.now() + 3000;
    while (!owned && Date.now() < deadline) {
      try {
        const pid = Number(await readFile(pidFile, "utf8")), current = await identity(pid);
        const environment = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
        const marker = environment.find(value => /^RCMCP_EXECUTION_ID=[a-f0-9-]{36}$/.test(value));
        if (current && marker) owned = { pid, identity: current, marker };
      } catch { /* Wait for this explicitly marked fixture command. */ }
      if (!owned) await pause(10);
    }
    expect(Boolean(owned)).toBe(true);
    agent.child.kill("SIGTERM");
    const exit = await within(agent.closed, 10000);
    expect(exit).toEqual([0, null]);
    expect(await identity(owned!.pid)).not.toBe(owned!.identity);
    const result = JSON.parse(await readFile(path.join(agent.root, "state", "exec-receipts-v1", receipt.id, "result.json"), "utf8"));
    expect(result).toMatchObject({ cancellationRequested: true, timedOut: false, terminationVerificationScope: expect.any(String) });
    expect(result.cancelled === true).toBe(result.terminationVerified === true);
    const { saved, claimPresent } = await agent.aggregate();
    expect(claimPresent).toBe(false);
    expect(saved.cleanShutdown).toBe(saved.previousUnfinished === 0);
  } finally {
    if (owned && await identity(owned.pid) === owned.identity) {
      const environment = (await readFile(`/proc/${owned.pid}/environ`, "utf8")).split("\0");
      expect(environment.includes(owned.marker)).toBe(true);
      if (await identity(owned.pid) === owned.identity) process.kill(owned.pid, "SIGKILL");
      const deadline = Date.now() + 2000;
      while (await identity(owned.pid) === owned.identity && Date.now() < deadline) await pause(10);
      expect(await identity(owned.pid)).not.toBe(owned.identity);
    }
    await agent.cleanup();
  }
}, 20000);
