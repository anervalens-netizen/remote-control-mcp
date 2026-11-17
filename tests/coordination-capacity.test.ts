import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { ResourceCoordinator, coordinationDevice, coordinationIdentity, coordinationHash, coordinationToken } from "../apps/agent/src/coordination.ts";
import { registerCoordinationRoutes } from "../apps/agent/src/coordination-routes.ts";
import { registerCoordinationTools } from "../apps/mcp-server/src/coordination-tools.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function fixture() {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "budget-diagnostic-"));
  const device = coordinationHash("synthetic-host");
  const owner = coordinationHash("owner");
  const now = Date.parse("2026-01-04T00:00:00.000Z");
  const c = new ResourceCoordinator(root, 4, () => now);
  const resource = (name: string, identity = owner) => ({
    device, identity, canonicalKey: coordinationHash("PRIVATE_RESOURCE_" + name),
    baseVersion: coordinationHash("base"),
  });
  return { root, device, owner, c, resource };
}

it("shows bounded state, identity and binding categories without exposing private journals or changing their bytes", () => {
  const { root, device, owner, c, resource } = fixture();
  const active = c.acquire(resource("active"));
  c.begin(coordinationToken(active), resource("active"));
  const pending = c.acquire(resource("pending"));
  c.begin(coordinationToken(pending), resource("pending"));
  c.bindExecution(coordinationToken(pending), { kind: "repo_job", key: "private-key",
    fingerprint: coordinationHash("fingerprint"), requestHash: coordinationHash("request") });
  c.attachJob(coordinationToken(pending), randomUUID());
  c.settle(coordinationToken(pending), { uncertain: true });
  const otherIdentity = coordinationHash("PRIVATE_other_identity");
  c.acquire(resource("other", otherIdentity));
  const missing = c.acquire(resource("missing"));
  unlinkSync(path.join(root, missing.resourceId + ".json"));
  const expected = c.inspectCapacity(device, owner);
  expect(expected).toMatchObject({ version: 1, budget: 4, freeSlots: 0, occupiedSlots: 4,
    visibility: "partial", noAutoRelease: true, snapshotConsistency: "non_atomic" });
  expect(expected.slots).toMatchObject([
    { slot: 0, state: "active", identityScope: "same", jobEvidence: "no_binding" },
    { slot: 1, state: "uncertain", identityScope: "same", jobEvidence: "bound_unverified" },
    { slot: 2, state: "reserved", identityScope: "other", jobEvidence: "no_binding" },
    { slot: 3, state: "orphan", identityScope: "unknown", jobEvidence: "unavailable" },
  ]);
  const rawJournal = readFileSync(path.join(root, pending.resourceId + ".json"));
  const summary = JSON.stringify(expected);
  expect(summary).not.toMatch(/PRIVATE_|private-key|resourceId|canonicalKey|operationId|jobId|baseVersion|token/);
  expect(summary).not.toContain(pending.resourceId);
  expect(summary).not.toContain(pending.operationId);
  expect(c.inspectCapacity(device, owner)).toEqual(expected);
  expect(readFileSync(path.join(root, pending.resourceId + ".json"))).toEqual(rawJournal);
  expect(() => c.acquire(resource("new"))).toThrow("device_backpressure");
});

it("preserves invalid slots and reports partial coverage without guessing status or reclaiming", () => {
  const { root, c, device, owner, resource } = fixture();
  const active = c.acquire(resource("active"));
  c.begin(coordinationToken(active), resource("active"));
  const first = c.inspectCapacity(device, owner);
  expect(first).toMatchObject({ visibility: "complete", freeSlots: 3, occupiedSlots: 1 });
  const corrupted = path.join(root, "slot-" + device + "-1.json");
  writeFileSync(corrupted, "{");
  const view = c.inspectCapacity(device, owner);
  expect(view.slots[1]).toMatchObject({ state: "unreadable", jobEvidence: "unavailable" });
  expect(view).toMatchObject({ visibility: "partial", freeSlots: 2, occupiedSlots: 2, noAutoRelease: true });
  expect(readFileSync(corrupted, "utf8")).toBe("{");
});

it("requires the existing agent HTTP bearer and rejects arbitrary diagnostic input", async () => {
  const { root, c } = fixture();
  vi.stubEnv("RCMCP_COORDINATION_DIR", root);
  vi.stubEnv("RCMCP_AGENT_TOKEN", "synthetic-secret");
  const app = Fastify();
  // No ambient authentication hook: this endpoint must enforce its own bearer
  // even when a development server permits unauthenticated requests.
  registerCoordinationRoutes(app);
  closers.push(() => app.close());
  const endpoint = "/v1/coordination/capacity";
  const unauthorized = await app.inject({ method: "POST", url: endpoint, payload: {} });
  expect(unauthorized.statusCode).toBe(401);
  const invalid = await app.inject({ method: "POST", url: endpoint, headers: { authorization: "Bearer synthetic-secret" },
    payload: { resource: { path: "/PRIVATE" } } });
  expect(invalid.statusCode).toBe(400);
  const token = c.acquire({ device: coordinationDevice, identity: coordinationIdentity,
    canonicalKey: coordinationHash("PRIVATE_repo_path"), baseVersion: coordinationHash("base") });
  const authorized = await app.inject({ method: "POST", url: endpoint,
    headers: { authorization: "Bearer synthetic-secret" }, payload: {} });
  expect(authorized.statusCode).toBe(200);
  expect(authorized.json()).toMatchObject({ budget: 4, occupiedSlots: 1, noAutoRelease: true });
  const output = authorized.body;
  expect(output).not.toContain(token.resourceId);
  expect(output).not.toContain(token.operationId);
  expect(output).not.toContain("PRIVATE");
});

it("advertises strict read-only MCP diagnostic and refuses unsupported old agents before dispatch", async () => {
  const { c, device, owner } = fixture();
  let modern = false;
  const info = vi.fn(async () => ({ runtime: { capabilities: modern
    ? ["high-level-coordination-v1", "coordination-capacity-v1"] : ["high-level-coordination-v1"] } }));
  const requestRoute = vi.fn(async (_device: string, route: string) => {
    expect(route).toBe("/v1/coordination/capacity");
    return c.inspectCapacity(device, owner);
  });
  const agent = { configuredContexts: () => ({ system: true, user: true, desktop: false }),
    info, requestRoute } as unknown as AgentClient;
  const server = new McpServer({ name: "capacity-fixture", version: "1" });
  installDefaultToolOutputContracts(server); registerCoordinationTools(server, agent);
  const client = new Client({ name: "capacity-test", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const tool = (await client.listTools()).tools.find(t => t.name === "coordination_capacity");
  expect(tool?.annotations?.readOnlyHint).toBe(true);
  expect(tool?.inputSchema?.properties).not.toHaveProperty("resource");
  const old = await client.callTool({ name: "coordination_capacity",
    arguments: { device: "fixture", identity: "owner" } });
  expect(old.isError).toBe(true);
  expect(JSON.stringify(old)).toContain("agent_upgrade_required");
  expect(requestRoute).not.toHaveBeenCalled();
  modern = true;
  const now = await client.callTool({ name: "coordination_capacity",
    arguments: { device: "fixture", identity: "owner" } });
  expect(now.isError, JSON.stringify(now)).not.toBe(true);
  expect((now.structuredContent as any).freeSlots).toBe(4);
  expect(requestRoute).toHaveBeenCalledTimes(1);
});
