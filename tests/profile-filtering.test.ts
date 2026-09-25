import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { findProcesses } from "../apps/agent/src/processes.ts";
import { repoSnapshot } from "../apps/agent/src/repo.ts";
import { summarizeDockerSnapshot } from "../apps/agent/src/docker.ts";
import { systemMetrics } from "../apps/agent/src/system.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import type { AgentClient, AgentEndpointContext } from "../apps/mcp-server/src/agent-client.ts";
import { registerAdvancedTools } from "../apps/mcp-server/src/advanced-tools.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { registerHostTools } from "../apps/mcp-server/src/host-tools.ts";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mcpHarness(register: (server: McpServer, client: AgentClient) => void, fake: AgentClient) {
  const server = new McpServer({ name: "profiles-test", version: "1" });
  register(server, fake);
  const client = new Client({ name: "profiles-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

function responseJson(response: unknown) {
  const content = (response as { content?: unknown }).content as Array<{ type: string; text?: string }>;
  return JSON.parse(content[0]!.text!);
}

describe("M12 compact profiles and agent-side filtering", () => {
  it("keeps repo full compatibility while summary omits heavyweight fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rcmcp-profile-repo-"));
    roots.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "RCMCP Test"], { cwd: dir });
    await writeFile(path.join(dir, "file.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });

    const summary = await repoSnapshot(dir, 1, "summary");
    const full = await repoSnapshot(dir, 1, "full");
    const legacyFull = await repoSnapshot(dir);

    expect(summary).toMatchObject({
      profile: "summary", head: full.head, branch: full.branch, clean: true, changedCount: 0,
    });
    expect(summary).not.toHaveProperty("gitDir");
    expect(summary).not.toHaveProperty("status");
    expect(summary).not.toHaveProperty("diffStat");
    expect(summary).not.toHaveProperty("remotes");
    expect(summary).not.toHaveProperty("recent");

    expect(full.profile).toBe("full");
    expect(full.gitDir).toBeTruthy();
    expect(full.commonGitDir).toBeTruthy();
    expect(full.status.length).toBeGreaterThan(0);
    expect(full.recent).toHaveLength(1);
    expect(legacyFull.profile).toBe("full");
    expect(legacyFull.gitDir).toBe(full.gitDir);
  });

  it("returns a light metrics profile without network-interface or full-filesystem payload", async () => {
    const light = await systemMetrics("light");
    const full = await systemMetrics("full");
    expect(light).toMatchObject({ profile: "light", hostname: os.hostname(), platform: process.platform });
    expect(light).toHaveProperty("rootFilesystem");
    expect(light).not.toHaveProperty("networkInterfaces");
    expect(light).not.toHaveProperty("filesystems");

    expect(full.profile).toBe("full");
    expect(full).toHaveProperty("networkInterfaces");
    expect(Array.isArray(full.filesystems)).toBe(true);
  });

  it("filters processes before returning the bounded result", async () => {
    const result = await findProcesses({ pid: process.pid, limit: 1 });
    expect(result.matched).toBe(1);
    expect(result.returned).toBe(1);
    const item = result.processes[0] as Record<string, unknown>;
    expect(Number(item.pid ?? item.ProcessId)).toBe(process.pid);
  });

  it("exposes compact agent routes without changing full defaults", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "rcmcp-profile-route-repo-"));
    roots.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "RCMCP Test"], { cwd: dir });
    await writeFile(path.join(dir, "file.txt"), "route\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir });

    const app = Fastify({ logger: false });
    registerExtraRoutes(app);
    await app.ready();
    closers.push(async () => { await app.close(); });

    const processResponse = await app.inject({
      method: "POST", url: "/v1/processes/find", payload: { pid: process.pid, limit: 1 },
    });
    expect(processResponse.statusCode).toBe(200);
    expect(processResponse.json()).toMatchObject({ matched: 1, returned: 1 });

    const metricsResponse = await app.inject({ method: "GET", url: "/v1/metrics?profile=light" });
    expect(metricsResponse.statusCode).toBe(200);
    expect(metricsResponse.json()).toMatchObject({ profile: "light", hostname: os.hostname() });
    expect(metricsResponse.json()).not.toHaveProperty("networkInterfaces");

    const repoResponse = await app.inject({
      method: "POST", url: "/v1/repo/snapshot", payload: { path: dir, profile: "summary", logCount: 1 },
    });
    expect(repoResponse.statusCode).toBe(200);
    expect(repoResponse.json()).toMatchObject({ profile: "summary", clean: true, changedCount: 0 });
    expect(repoResponse.json()).not.toHaveProperty("gitDir");

    const legacyRepoResponse = await app.inject({
      method: "POST", url: "/v1/repo/snapshot", payload: { path: dir, logCount: 1 },
    });
    expect(legacyRepoResponse.statusCode).toBe(200);
    expect(legacyRepoResponse.json()).toMatchObject({ profile: "full", clean: true });
    expect(legacyRepoResponse.json()).toHaveProperty("gitDir");
  });

  it("filters and compacts Docker container matches independently of Docker availability", () => {
    const result = summarizeDockerSnapshot({
      available: true,
      version: {},
      containers: [
        { Names: "api", Image: "api:v1", State: "running", Status: "Up 1m", Ports: "8080/tcp" },
        { Names: "worker", Image: "worker:v1", State: "running", Status: "Up 1m (unhealthy)", Ports: "" },
        { Names: "old-api", Image: "api:v0", State: "exited", Status: "Exited (0)", Ports: "" },
      ],
      images: [{}, {}],
      compose: [{ Name: "stack", Status: "running(2)" }],
      errors: [],
    }, { query: "api", state: "running", limit: 1 });

    expect(result.containers).toMatchObject({ total: 3, running: 2, stopped: 1, unhealthy: ["worker"] });
    expect(result).toMatchObject({ images: 2, matched: 1, returned: 1, filter: { query: "api", state: "running" } });
    expect(result.matches).toEqual([{ name: "api", image: "api:v1", state: "running", status: "Up 1m", ports: "8080/tcp" }]);
  });

  it("high-level helpers request compact agent-side operations instead of full payloads", async () => {
    const seen: Array<{ method: string; input?: unknown; context?: AgentEndpointContext; route?: string }> = [];
    const fake = {
      devices: [{ name: "pc" }],
      configuredContexts: () => ({ system: true, user: true, desktop: false }),
      processFind: async (_device: string, input: unknown, context: AgentEndpointContext) => {
        seen.push({ method: "processFind", input, context });
        return { matched: 1, returned: 1, processes: [{ pid: 42, command: "needle" }] };
      },
      processes: async () => { throw new Error("full process list should not be requested"); },
      dockerSummary: async (_device: string, input: unknown, context: AgentEndpointContext) => {
        seen.push({ method: "dockerSummary", input, context });
        return { available: true, containers: { total: 1, running: 1, stopped: 0, unhealthy: [] }, images: 1, compose: [], errors: [], matched: 1, returned: 1, matches: [] };
      },
      dockerSnapshot: async () => { throw new Error("full Docker snapshot should not be requested"); },
      repoSnapshot: async (_device: string, input: unknown, context: AgentEndpointContext) => {
        seen.push({ method: "repoSnapshot", input, context });
        return { head: "abc", branch: "main", upstream: null, clean: true, ahead: 0, behind: 0 };
      },
      requestRoute: async (_device: string, route: string, _body: unknown, context: AgentEndpointContext) => {
        seen.push({ method: "requestRoute", route, context });
        return {
          hostname: "pc", platform: "linux", arch: "x64", uptimeSeconds: 1,
          cpuCount: 4, cpuModel: "cpu", totalMemoryBytes: 100, freeMemoryBytes: 50,
          rootFilesystem: { usedPercent: "50%", availableBytes: 50 },
        };
      },
    } as unknown as AgentClient;

    const client = await mcpHarness(registerHighLevelTools, fake);
    expect((await client.callTool({ name: "process_find", arguments: { device: "pc", query: "needle", limit: 1 } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "docker_summary", arguments: { device: "pc", query: "api", state: "running", limit: 2 } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "repo_compare", arguments: { items: [{ device: "pc", path: "/repo" }] } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "repo_snapshot", arguments: { device: "pc", path: "/repo", profile: "summary" } })).isError).not.toBe(true);
    const fleet = await client.callTool({ name: "fleet_status", arguments: { devices: ["pc"] } });
    expect(responseJson(fleet).devices[0]).toMatchObject({ online: true, hostname: "pc", memoryUsedPercent: 50 });

    expect(seen).toContainEqual({ method: "processFind", input: { query: "needle", pid: undefined, limit: 1 }, context: undefined });
    expect(seen).toContainEqual({ method: "dockerSummary", input: { query: "api", state: "running", limit: 2 }, context: undefined });
    expect(seen).toContainEqual({ method: "repoSnapshot", input: { path: "/repo", logCount: 1, profile: "summary" }, context: "user" });
    expect(seen).toContainEqual({ method: "repoSnapshot", input: { path: "/repo", logCount: undefined, profile: "summary" }, context: "user" });
    expect(seen).toContainEqual({ method: "requestRoute", route: "/v1/metrics?profile=light", context: "system" });
  });

  it("system_metrics and host_inventory forward light/full profiles without changing full defaults", async () => {
    const seen: string[] = [];
    const fake = {
      requestRoute: async (_device: string, route: string) => {
        seen.push(route);
        return { profile: route.includes("profile=light") ? "light" : "full", hostname: "pc" };
      },
      networkSnapshot: async () => { seen.push("network"); return {}; },
      storageSnapshot: async () => { seen.push("storage"); return {}; },
      gpuSnapshot: async () => { seen.push("gpu"); return {}; },
      packageManagers: async () => { seen.push("packages"); return []; },
    } as unknown as AgentClient;

    const metricsClient = await mcpHarness(registerAdvancedTools, fake);
    const lightMetrics = await metricsClient.callTool({ name: "system_metrics", arguments: { device: "pc", profile: "light" } });
    expect(responseJson(lightMetrics)).toMatchObject({ profile: "light", hostname: "pc" });
    const hostClient = await mcpHarness(registerHostTools, fake);
    const lightInventory = await hostClient.callTool({ name: "host_inventory", arguments: { device: "pc", profile: "light" } });
    expect(responseJson(lightInventory)).toMatchObject({ profile: "light", partial: false, metrics: { profile: "light" } });
    expect(seen.filter((item) => item === "network")).toHaveLength(0);

    const fullInventory = await hostClient.callTool({ name: "host_inventory", arguments: { device: "pc" } });
    expect(responseJson(fullInventory)).toMatchObject({ profile: "full", partial: false });
    expect(seen).toContain("/v1/metrics?profile=full");
    expect(seen).toContain("network");
    expect(seen).toContain("storage");
    expect(seen).toContain("gpu");
    expect(seen).toContain("packages");
  });
});
