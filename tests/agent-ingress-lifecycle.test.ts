import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { registerAgentIngress } from "../apps/agent/src/ingress-http.ts";
import { IngressObserver } from "../apps/agent/src/ingress-observer.ts";

const start = { route: "/health", method: "GET", entryPoint: "unattributed", authentication: "bearer_verified" } as const;
const nodeModule = new URL("../apps/agent/src/ingress-observer.ts", import.meta.url).href;
const count = (value: IngressObserver) => value.finish(value.begin(start), { statusCode: 200 });
const childSource = [
  "import { IngressObserver } from " + JSON.stringify(nodeModule) + ";",
  "const value = new IngressObserver({ identity: 'owner', stateDirectory: process.argv[1], knownRoutes: ['/health'] });",
  "value.finish(value.begin({ route: '/health', method: 'GET', entryPoint: 'unattributed', authentication: 'bearer_verified' }), { statusCode: 200 });",
];

it("refuses a competing aggregate writer while retaining readable history and working memory counters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-writer-"));
  const first = new IngressObserver({ identity: "owner", stateDirectory: root });
  try {
    count(first); first.flush();
    const before = await readFile(path.join(root, "aggregate.json"), "utf8");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      [...childSource, "value.flush(); console.log(JSON.stringify(value.snapshot())); value.close();"].join("\n"), root],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const snapshot = JSON.parse(child.stdout);
    expect(snapshot.totals).toMatchObject({ received: 1, completed: 1 });
    expect(snapshot.coverage).toMatchObject({ persistence: "unavailable", repairRequired: true, processCountsComplete: true });
    expect(snapshot.coverage.faults).toContain("state_writer_locked");
    expect(snapshot.history.partial).toBe(true);
    expect(snapshot.history.days[0].received).toBe(2); // Retained baseline plus this process's unsaved request.
    expect(snapshot.history.gaps).toEqual([expect.objectContaining({
      reason: "writer_continuity_unknown", previousUnfinished: 0,
    })]); // Unknown continuity does not assert that a live competing writer restarted.
    expect(await readFile(path.join(root, "aggregate.json"), "utf8")).toBe(before);
    count(first); first.flush();
    expect(JSON.parse(await readFile(path.join(root, "aggregate.json"), "utf8")).days[0].received).toBe(2);
  } finally {
    first.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it.skipIf(process.platform === "win32")("preserves an orphan writer claim after a crash without stealing or overwriting retained aggregates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-crash-"));
  let second: IngressObserver | undefined;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      [...childSource, "value.begin({ route: '/health', method: 'GET', entryPoint: 'unattributed', authentication: 'bearer_verified' }); value.flush(); process.kill(process.pid, 'SIGKILL');"].join("\n"), root],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 65536 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBe("SIGKILL");
    const file = path.join(root, "aggregate.json");
    const before = await readFile(file, "utf8");
    const prior = JSON.parse(before);
    const beforeClaim = await readFile(file + ".writer", "utf8");
    const restartedAt = new Date(Date.parse(prior.lastSavedAt) + 30_000).toISOString();
    second = new IngressObserver({ identity: "owner", stateDirectory: root, now: () => Date.parse(restartedAt) });
    expect(second.snapshot().history.days[0]?.received).toBe(2);
    expect(second.snapshot().history.gaps).toContainEqual({
      reason: "writer_continuity_unknown", from: prior.lastSavedAt, to: restartedAt, previousUnfinished: 1,
    });
    expect(second.snapshot().totals.inFlight).toBe(0);
    count(second); second.flush(); second.close();
    expect(second.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
    expect(second.snapshot().coverage.faults).toContain("state_writer_locked");
    expect(second.snapshot().totals.received).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await readFile(file + ".writer", "utf8")).toBe(beforeClaim);
  } finally {
    second?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it("labels process counters separately from retained UTC aggregates after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-scope-"));
  const first = new IngressObserver({ identity: "owner", stateDirectory: root });
  let second: IngressObserver | undefined;
  try {
    count(first); first.close();
    second = new IngressObserver({ identity: "owner", stateDirectory: root });
    const snapshot = second.snapshot();
    expect(snapshot).toMatchObject({ counterScope: "current_process", totals: { received: 0 }, sequence: 0 });
    expect(snapshot.history).toMatchObject({ scope: "retained_utc_arrival_days", days: [expect.objectContaining({ received: 1 })] });
    expect(snapshot.coverage).toMatchObject({ persistenceScope: "daily_aggregates", processCountsComplete: true, persistence: "confirmed" });
    expect(second.instanceId).not.toBe(first.instanceId);
  } finally {
    first.close(); second?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("coalesces the response-close and request-abort signals for one real client abort", async () => {
  const app = Fastify({ logger: false });
  const token = randomUUID();
  const observer = registerAgentIngress(app, { token, allowUnauthenticated: false, identity: "owner", instanceId: randomUUID() });
  let admitted!: () => void;
  const started = new Promise<void>(resolve => { admitted = resolve; });
  app.addHook("onRequest", async () => { admitted(); });
  app.post("/incomplete", async () => ({ ok: true }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const req = request({ hostname: "127.0.0.1", port, path: "/incomplete", method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", "content-length": "1024" } });
  req.on("error", () => {});
  try {
    req.write('{"unfinished":');
    await started;
    req.destroy();
    const deadline = Date.now() + 3000;
    while (observer.snapshot().totals.completed < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(observer.snapshot().totals).toMatchObject({ received: 1, completed: 1, disconnected: 1, response: 0, inFlight: 0 });
    expect(observer.snapshot().duplicateCompletions).toBe(0);
  } finally {
    req.destroy(); await app.close();
  }
}, 5000);

it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGINT"] as const)(
  "closes the actual isolated agent on %s and persists a clean restart marker", async signal => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ingress-shutdown-"));
    const token = randomUUID();
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
    Object.assign(env, { RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: String(port),
      RCMCP_AGENT_TOKEN: token, RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_DESKTOP_ENABLED: "0" });
    const boot = async () => {
      const child = spawn(process.execPath, [path.resolve("apps/agent/src/index.ts")], {
        env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const closed = once(child, "close");
      let logs = "";
      child.stdout.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
      child.stderr.on("data", chunk => { logs = (logs + chunk).slice(-8192); });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try {
          const response = await fetch("http://127.0.0.1:" + port + "/v1/info", {
            headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(500),
          });
          if (response.ok) return { child, closed, info: await response.json() as { runtime: { instanceId: string } } };
        } catch { /* Wait only for this isolated child. */ }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      child.kill("SIGKILL"); await closed;
      throw new Error("Isolated agent failed to start: " + logs);
    };
    let live: Awaited<ReturnType<typeof boot>> | undefined;
    try {
      live = await boot();
      const firstInstance = live.info.runtime.instanceId;
      live.child.kill(signal);
      const result = await Promise.race([live.closed, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Isolated shutdown timed out")), 5000); timer.unref();
      })]);
      expect(result).toEqual([0, null]);
      const file = path.join(root, "state", "agent-ingress-v1", "aggregate.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      expect(saved).toMatchObject({ cleanShutdown: true, previousUnfinished: 0, lastInstanceId: firstInstance });
      live = await boot();
      expect(live.info.runtime.instanceId).not.toBe(firstInstance);
      live.child.kill(signal); await live.closed;
      const restarted = JSON.parse(await readFile(file, "utf8"));
      expect(restarted.cleanShutdown).toBe(true);
      expect(restarted.gaps.at(-1)?.reason).toBe("clean_restart_interval");
      expect(restarted.gaps.some((gap: { reason: string }) => gap.reason === "unclean_restart")).toBe(false);
    } finally {
      if (live && live.child.exitCode === null && live.child.signalCode === null) {
        live.child.kill("SIGKILL"); await live.closed;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }, 30000,
);

it("releases only its own writer claim and fences publication after ownership is replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-fence-"));
  const value = new IngressObserver({ identity: "owner", stateDirectory: root });
  const file = path.join(root, "aggregate.json");
  const claim = file + ".writer";
  try {
    count(value); value.flush();
    const before = await readFile(file, "utf8");
    await rename(claim, claim + ".preserved");
    await writeFile(claim, "synthetic other writer claim");
    count(value); value.flush();
    expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
    expect(value.snapshot().coverage.faults).toContain("state_writer_lost");
    value.close();
    expect(await readFile(claim, "utf8")).toBe("synthetic other writer claim");
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    value.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("releases the isolated agent's own telemetry claim when listener startup fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-startup-"));
  const token = randomUUID();
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const port = (occupied.address() as { port: number }).port;
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
  Object.assign(env, { RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: String(port),
    RCMCP_AGENT_TOKEN: token, RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_DESKTOP_ENABLED: "0" });
  const child = spawn(process.execPath, [path.resolve("apps/agent/src/index.ts")], { env, stdio: "ignore", windowsHide: true });
  const closed = once(child, "close");
  try {
    const result = await Promise.race([closed, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Isolated startup failed to settle")), 10000); timer.unref();
    })]);
    expect(result).toEqual([1, null]);
    const file = path.join(root, "state", "agent-ingress-v1", "aggregate.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ cleanShutdown: true, previousUnfinished: 0 });
    await expect(readFile(file + ".writer")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);

it("reports lost writer ownership when its claim disappears and never recreates it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-missing-claim-"));
  const value = new IngressObserver({ identity: "owner", stateDirectory: root });
  const file = path.join(root, "aggregate.json");
  try {
    count(value); value.flush();
    const before = await readFile(file, "utf8");
    await rm(file + ".writer");
    count(value); value.flush();
    expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
    expect(value.snapshot().coverage.faults).toContain("state_writer_lost");
    expect(value.snapshot().history.partial).toBe(true);
    expect(value.snapshot().totals).toMatchObject({ received: 2, completed: 2 });
    value.close();
    expect(await readFile(file, "utf8")).toBe(before);
    await expect(readFile(file + ".writer")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    value.close();
    await rm(root, { recursive: true, force: true });
  }
});
