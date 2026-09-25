import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { advancedClient } from "../apps/mcp-server/src/advanced-client.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("AgentClient", () => {
  it("routes exec to the named device with bearer auth", async () => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer secret");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, signal: null, stdout: "ok\n", stderr: "", durationMs: 1, timedOut: false }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");

    const client = new AgentClient([{ name: "server", url: `http://127.0.0.1:${address.port}` }], "secret");
    const result = await client.exec("SERVER", { command: "echo ok" });
    expect(result.stdout).toBe("ok\n");
  });

  it("routes desktop tools to the separate interactive endpoint", async () => {
    let normalHits = 0;
    const normal = createServer((_req, res) => { normalHits += 1; res.setHeader("content-type", "application/json"); res.end("{}"); });
    const desktop = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer desktop-secret");
      expect(req.url).toBe("/v1/desktop/monitors");
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ deviceName: "DISPLAY1" }]));
    });
    servers.push(normal, desktop);
    await Promise.all([new Promise<void>((resolve) => normal.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => desktop.listen(0, "127.0.0.1", resolve))]);
    const n = normal.address(); const d = desktop.address();
    if (!n || typeof n === "string" || !d || typeof d === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "Gaming", url: `http://127.0.0.1:${n.port}`, token: "host-secret", desktopUrl: `http://127.0.0.1:${d.port}`, desktopToken: "desktop-secret" }]);
    expect(await client.desktopMonitors("gaming")).toEqual([{ deviceName: "DISPLAY1" }]);
    expect(normalHits).toBe(0);
  });

  it("routes explicit user context to the user endpoint", async () => {
    let systemHits = 0;
    const system = createServer((_req, res) => { systemHits += 1; res.setHeader("content-type", "application/json"); res.end("{}"); });
    const user = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer user-secret");
      expect(req.url).toBe("/v1/exec");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ code: 0, signal: null, stdout: "user\n", stderr: "", durationMs: 1, timedOut: false, stdoutBytes: 5, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false }));
    });
    servers.push(system, user);
    await Promise.all([new Promise<void>((resolve) => system.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => user.listen(0, "127.0.0.1", resolve))]);
    const a = system.address(); const b = user.address();
    if (!a || typeof a === "string" || !b || typeof b === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "pc", url: `http://127.0.0.1:${a.port}`, token: "system-secret", userUrl: `http://127.0.0.1:${b.port}`, userToken: "user-secret" }]);
    const result = await client.exec("pc", { command: "whoami" }, "user");
    expect(result.stdout).toBe("user\n");
    expect(systemHits).toBe(0);
  });


  it("rejects unavailable user context instead of falling back to system", async () => {
    let systemHits = 0;
    const system = createServer((_req, res) => { systemHits += 1; res.setHeader("content-type", "application/json"); res.end("{}"); });
    servers.push(system);
    await new Promise<void>((resolve) => system.listen(0, "127.0.0.1", resolve));
    const address = system.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "system-only", url: `http://127.0.0.1:${address.port}` }]);
    await expect(client.fsWrite("system-only", { path: "/tmp/x", data: "x" }, "user")).rejects.toMatchObject({
      name: "AgentRequestError", kind: "context", device: "system-only", context: "user", route: "/v1/fs/write",
    });
    expect(systemHits).toBe(0);
    expect(client.configuredContexts("system-only")).toEqual({ system: true, user: false, desktop: false });
  });

  it("routes user-scoped service operations to the user endpoint", async () => {
    let systemHits = 0;
    const system = createServer((_req, res) => { systemHits += 1; res.setHeader("content-type", "application/json"); res.end("{}"); });
    const user = createServer((req, res) => {
      expect(req.url).toBe("/v1/service");
      expect(req.headers.authorization).toBe("Bearer user-secret");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ActiveState: "active" }));
    });
    servers.push(system, user);
    await Promise.all([new Promise<void>((resolve) => system.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => user.listen(0, "127.0.0.1", resolve))]);
    const a = system.address(); const b = user.address();
    if (!a || typeof a === "string" || !b || typeof b === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "pc", url: `http://127.0.0.1:${a.port}`, token: "system-secret", userUrl: `http://127.0.0.1:${b.port}`, userToken: "user-secret" }]);
    const result = await advancedClient.service(client, "pc", { name: "example.service", action: "status", scope: "user" });
    expect(result).toEqual({ ActiveState: "active" });
    expect(systemHits).toBe(0);
  });

  it("routes filesystem operations through the requested user context", async () => {
    let systemHits = 0;
    const system = createServer((_req, res) => { systemHits += 1; res.setHeader("content-type", "application/json"); res.end("{}"); });
    const user = createServer((req, res) => {
      expect(req.url).toBe("/v1/fs/read");
      expect(req.headers.authorization).toBe("Bearer user-secret");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: "/tmp/x", bytesRead: 2, data: "ok" }));
    });
    servers.push(system, user);
    await Promise.all([new Promise<void>((resolve) => system.listen(0, "127.0.0.1", resolve)), new Promise<void>((resolve) => user.listen(0, "127.0.0.1", resolve))]);
    const a = system.address(); const b = user.address();
    if (!a || typeof a === "string" || !b || typeof b === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "pc", url: `http://127.0.0.1:${a.port}`, token: "system-secret", userUrl: `http://127.0.0.1:${b.port}`, userToken: "user-secret" }]);
    expect(await client.fsRead("pc", { path: "/tmp/x" }, "user")).toMatchObject({ data: "ok" });
    expect(systemHits).toBe(0);
    expect(client.configuredContexts("pc")).toEqual({ system: true, user: true, desktop: false });
  });

  it("aborts a stalled agent request at the configured transport deadline", async () => {
    const stalled = createServer((_req, _res) => { /* intentionally never responds */ });
    servers.push(stalled);
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "slow", url: `http://127.0.0.1:${address.port}` }], undefined, 50);
    const started = Date.now();
    await expect(client.info("slow")).rejects.toMatchObject({ name: "AgentRequestError", kind: "timeout", device: "slow", context: "system" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("extends package mutation transport deadlines beyond the generic client timeout", async () => {
    const delayed = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }, 60);
    });
    servers.push(delayed);
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    const address = delayed.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "pkg", url: `http://127.0.0.1:${address.port}` }], undefined, 20);
    await expect(client.packageManage("pkg", { action: "install", packages: ["x"], timeoutMs: 100 }, "system")).resolves.toEqual({ ok: true });
  });

  it("extends Git network transport deadlines beyond the generic client timeout", async () => {
    const delayed = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }, 60);
    });
    servers.push(delayed);
    await new Promise<void>((resolve) => delayed.listen(0, "127.0.0.1", resolve));
    const address = delayed.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "git", url: `http://127.0.0.1:${address.port}`, userUrl: `http://127.0.0.1:${address.port}` }], undefined, 20);
    await expect(client.repoFetch("git", { path: "/repo", timeoutMs: 100 }, "user")).resolves.toEqual({ ok: true });
  });

  it("keeps the transport deadline active while the response body stalls", async () => {
    const stalled = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{\"partial\":");
    });
    servers.push(stalled);
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new AgentClient([{ name: "slow-body", url: `http://127.0.0.1:${address.port}` }], undefined, 50);
    await expect(client.info("slow-body")).rejects.toMatchObject({ name: "AgentRequestError", kind: "timeout", device: "slow-body" });
  });

});

describe("rolling-upgrade compact route compatibility", () => {
  it.each([404, 401, 500])("only falls back on HTTP 404 (status %i), retaining owner context and filters", async (status) => {
    const routes: string[] = [];
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer owner-test");
      routes.push(req.url!);
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/processes/find" || req.url === "/v1/docker/summary") {
        res.statusCode = status; res.end(JSON.stringify({ error: "test" })); return;
      }
      if (req.url === "/v1/processes") {
        res.end(JSON.stringify([{ pid: 10, name: "wanted" }, { pid: 11, name: "other" }])); return;
      }
      res.end(JSON.stringify({ available: true, containers: [
        { Names: "wanted", State: "running", Image: "img", Status: "Up" },
        { Names: "other", State: "exited", Image: "img", Status: "Exited" },
      ], images: [], compose: [], errors: [] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new AgentClient([{ name: "pc", url: "http://127.0.0.1:1", userUrl: url, userToken: "owner-test" }]);
    if (status === 404) {
      expect(await client.processFind("pc", { query: "wanted", pid: 10, limit: 1 }, "user")).toMatchObject({ matched: 1, returned: 1, processes: [{ pid: 10 }] });
      expect(await client.dockerSummary("pc", { query: "wanted", state: "running", limit: 1 }, "user")).toMatchObject({ matched: 1, returned: 1, containers: { total: 2 }, matches: [{ name: "wanted" }] });
      expect(routes).toEqual(["/v1/processes/find", "/v1/processes", "/v1/docker/summary", "/v1/docker/snapshot"]);
    } else {
      await expect(client.processFind("pc", {}, "user")).rejects.toMatchObject({ status });
      await expect(client.dockerSummary("pc", {}, "user")).rejects.toMatchObject({ status });
      expect(routes).toEqual(["/v1/processes/find", "/v1/docker/summary"]);
    }
  });
});
