import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request, type ClientRequest } from "node:http";
import { createServer } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let cancel = () => {};
  const timeout = new Promise<undefined>(resolve => {
    const timer = setTimeout(() => resolve(undefined), ms); cancel = () => clearTimeout(timer);
  });
  try { return await Promise.race([promise, timeout]); } finally { cancel(); }
}
async function identity(
  pid: number,
  readStat: (file: string, encoding: "utf8") => Promise<string> = readFile,
): Promise<string | undefined> {
  try {
    const text = await readStat(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).trim().split(/\s+/);
    return ["Z", "X"].includes(fields[0]!) ? undefined : `${pid}:${fields[19]}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
}

it.each(["ENOENT", "ESRCH"])("treats deadline procfs %s as a vanished process", async code => {
  const error = Object.assign(new Error("synthetic procfs read failure"), { code });
  await expect(identity(12345, async () => { throw error; })).resolves.toBeUndefined();
});

it.each(["EACCES", "EIO"])("preserves unexpected deadline procfs %s errors", async code => {
  const error = Object.assign(new Error("synthetic procfs read failure"), { code });
  await expect(identity(12345, async () => { throw error; })).rejects.toBe(error);
});

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(options: { host?: string; preload?: string; waitForReady?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-shutdown-deadline-"));
  const token = randomUUID(), reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
  Object.assign(env, { HOME: root, ENV: "/dev/null", BASH_ENV: "/dev/null", HISTFILE: "/dev/null",
    RCMCP_AGENT_HOST: options.host ?? "127.0.0.1", RCMCP_AGENT_PORT: String(port), RCMCP_AGENT_TOKEN: token,
    RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_DESKTOP_ENABLED: "0", RCMCP_JOB_CGROUP_ISOLATION: "0" });
  const args: string[] = [];
  const preloads: string[] = [];
  if (options.host === "localhost") {
    // Exercise Fastify's real secondary listener without relying on host DNS or
    // IPv6 availability. Only this isolated child's localhost lookup changes.
    preloads.push(`import dns from 'node:dns';
const lookup = dns.lookup;
dns.lookup = function(host, options, callback) {
  if (host !== 'localhost') return lookup.apply(this, arguments);
  if (typeof options === 'function') { callback = options; options = {}; }
  process.nextTick(() => options?.all
    ? callback(null, [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }])
    : callback(null, '127.0.0.2', 4));
};
`);
  }
  if (options.preload) preloads.push(options.preload);
  if (preloads.length) {
    const preload = path.join(root, "preload.mjs");
    await writeFile(preload, preloads.join("\n"));
    args.push("--import", preload);
  }
  args.push(path.resolve("apps/agent/src/index.ts"));
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close"), clients: ClientRequest[] = [];
  const childIdentity = await identity(child.pid!);
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
    if (childIdentity && await identity(child.pid!) === childIdentity) child.kill("SIGKILL");
    expect(await within(closed, 5000)).toBeDefined();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  try {
    if (options.waitForReady !== false) {
      let ready = false;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try { if ((await call("/v1/info")).runtime?.pid === child.pid) { ready = true; break; } } catch { /* isolated boot */ }
        await pause(25);
      }
      expect(ready, logs).toBe(true);
    }
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
  return { root, child, closed, call, open, cleanup, aggregate, logs: () => logs };
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
        .toEqual({ exited: true, code: null, signal: "SIGTERM", claimPresent: false });
      expect(performance.now() - started).toBeLessThan(10000);
      const disconnected = saved.days.reduce((sum: number, row: { disconnected: number }) => sum + row.disconnected, 0);
      expect(disconnected + saved.previousUnfinished).toBeGreaterThanOrEqual(1);
      expect(saved.cleanShutdown).toBe(saved.previousUnfinished === 0);
      if (saved.previousUnfinished) expect(saved.faults).toContain("closed_with_inflight");
    } finally { await agent.cleanup(); }
  }, 20000,
);

it.skipIf(process.platform !== "linux").each(["127.0.0.1", "localhost"])("drains cancellation of an owned foreground exec on %s before exiting", async host => {
  const agent = await fixture({ host });
  let owned: { pid: number; identity: string; marker: string } | undefined;
  try {
    if (host === "localhost") {
      expect(agent.logs()).toContain("http://127.0.0.2:");
      expect(agent.logs().indexOf("http://127.0.0.2:")).toBeLessThan(agent.logs().indexOf("http://127.0.0.1:"));
    }
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
    expect(exit).toEqual([null, "SIGTERM"]);
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


it.skipIf(process.platform !== "linux").each([false, true])(
  "exits with a FIFO-blocked worker after client disconnected=%s", async disconnected => {
    const agent = await fixture();
    try {
      const fifo = path.join(agent.root, "blocked-read.fifo");
      const created = spawnSync("mkfifo", [fifo], { timeout: 2000 });
      expect(created.status).toBe(0);
      const req = agent.open("/v1/fs/read", JSON.stringify({ path: fifo, encoding: "base64", length: 1 }), true);
      let blocked = false;
      const deadline = Date.now() + 3000;
      while (!blocked && Date.now() < deadline) {
        const tasks = await readdir(`/proc/${agent.child.pid}/task`);
        for (const task of tasks) {
          const wait = await readFile(`/proc/${agent.child.pid}/task/${task}/wchan`, "utf8").catch(() => "");
          if (wait.trim() === "wait_for_partner") { blocked = true; break; }
        }
        if (!blocked) await pause(10);
      }
      expect(blocked).toBe(true);
      if (disconnected) {
        req.destroy();
        let ended = false;
        const deadline = Date.now() + 2000;
        while (!ended && Date.now() < deadline) {
          const snapshot = await agent.call("/v1/observations/ingress", { sampleLimit: 0, seriesLimit: 0, historyLimit: 0 });
          ended = snapshot.totals.inFlight === 1; // The snapshot request itself.
          if (!ended) await pause(10);
        }
        expect(ended).toBe(true);
      }
      const started = performance.now();
      agent.child.kill("SIGTERM");
      const exit = await within(agent.closed, 10000);
      expect(exit).toEqual([null, "SIGTERM"]);
      expect(performance.now() - started).toBeLessThan(10000);
      expect((await agent.aggregate()).claimPresent).toBe(false);
    } finally { await agent.cleanup(); }
  }, 20000,
);

it.skipIf(process.platform !== "linux")("handles SIGTERM immediately after creating its writer claim", async () => {
  const preload = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.openSync;
fs.openSync = function(file, ...args) {
  const fd = open.call(this, file, ...args);
  if (String(file).endsWith('/aggregate.json.writer')) process.kill(process.pid, 'SIGTERM');
  return fd;
};
syncBuiltinESMExports();
`;
  const agent = await fixture({ preload, waitForReady: false });
  try {
    expect(await within(agent.closed, 5000)).toEqual([null, "SIGTERM"]);
    const writer = path.join(agent.root, "state", "agent-ingress-v1", "aggregate.json.writer");
    const claim = await readFile(writer).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    expect(claim).toBe(false);
    const { saved, claimPresent } = await agent.aggregate();
    expect(claimPresent).toBe(false);
    expect(saved.cleanShutdown).toBe(true);
    expect(saved.previousUnfinished).toBe(0);
  } finally { await agent.cleanup(); }
}, 10000);


it.skipIf(process.platform !== "linux")("keeps a cleanup failure distinct from a normal stop signal", async () => {
  const observer = pathToFileURL(path.resolve("apps/agent/src/ingress-observer.ts")).href;
  const preload = `import { IngressObserver } from ${JSON.stringify(observer)};
import { appendFileSync } from 'node:fs';
const close = IngressObserver.prototype.close;
IngressObserver.prototype.close = function() {
  close.call(this);
  appendFileSync(process.env.RCMCP_STATE_DIR + '/cleanup-error-calls', 'x');
  throw new Error('synthetic ingress cleanup failure');
};
`;
  const agent = await fixture({ preload });
  try {
    agent.child.kill("SIGTERM");
    expect(await within(agent.closed, 3000)).toEqual([null, "SIGKILL"]);
    // Async logger delivery is not guaranteed after signal termination. Check
    // both actual failing cleanup calls through this isolated fixture marker.
    expect(await readFile(path.join(agent.root, "state", "cleanup-error-calls"), "utf8")).toBe("xx");
    expect((await agent.aggregate()).claimPresent).toBe(false);
  } finally { await agent.cleanup(); }
}, 10000);

it.skipIf(process.platform !== "linux")("reports a stalled async close hook after the full shutdown drain", async () => {
  const browser = pathToFileURL(path.resolve("apps/agent/src/browser.ts")).href;
  const preload = `import { BrowserManager } from ${JSON.stringify(browser)};
import { writeFileSync } from 'node:fs';
BrowserManager.prototype.close = async function() {
  writeFileSync(process.env.RCMCP_STATE_DIR + '/close-hook-started', 'started');
  await new Promise(() => {});
};
`;
  const agent = await fixture({ preload });
  try {
    const started = performance.now();
    agent.child.kill("SIGTERM");
    expect(await within(agent.closed, 12000)).toEqual([null, "SIGKILL"]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(7900);
    expect(await readFile(path.join(agent.root, "state", "close-hook-started"), "utf8")).toBe("started");
    expect((await agent.aggregate()).claimPresent).toBe(false);
  } finally { await agent.cleanup(); }
}, 24000);
