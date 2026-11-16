import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerCoordinationTools } from "../apps/mcp-server/src/coordination-tools.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import { coordinationHash, coordinationToken, ResourceCoordinator } from "../apps/agent/src/coordination.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
it.each(["inspect_recovery", "prepare_recovery", "reconcile"])("gates %s before agent dispatch and preserves existing inspection", async action => {
  let capable = false;
  const resource = { device: coordinationHash("fixture"), identity: coordinationHash("owner"), canonicalKey: coordinationHash(randomUUID()), baseVersion: coordinationHash("base") };
  const coordinator = new ResourceCoordinator(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "mcp-recovery-")));
  const record = coordinator.acquire(resource);
  const request = vi.fn(async (_device: string, _route: string, input: { action: string }) => input.action.startsWith("inspect")
    ? input.action === "inspect" ? coordinator.inspect(resource) : coordinator.inspectRecovery(resource) : { record, noReplay: true, alreadyReconciled: true });
  const info = vi.fn(async () => ({ runtime: { capabilities: capable ? ["high-level-coordination-v1", "coordination-recovery-v1"] : ["high-level-coordination-v1"] } }));
  const agent = { configuredContexts: () => ({ system: true, user: true, desktop: false }), info, requestRoute: request } as unknown as AgentClient;
  const server = new McpServer({ name: "fixture", version: "1" }); installDefaultToolOutputContracts(server); registerCoordinationTools(server, agent);
  const client = new Client({ name: "fixture", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  close.push(() => server.close(), () => client.close());
  const args = { device: "fixture", identity: "owner", resource: { kind: "repo", path: "synthetic" }, token: coordinationToken(record), expectedCurrentBaseVersion: resource.baseVersion };
  const blocked = await client.callTool({ name: "resource_coordination", arguments: { ...args, action } });
  expect(blocked.isError).toBe(true); expect(JSON.stringify(blocked)).toContain("agent_upgrade_required"); expect(request).not.toHaveBeenCalled();
  const inspected = await client.callTool({ name: "resource_coordination", arguments: { ...args, action: "inspect" } });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true); expect(request).toHaveBeenCalledTimes(1);
  capable = true;
  const result = await client.callTool({ name: "resource_coordination", arguments: { ...args, action } });
  expect(result.isError).not.toBe(true); expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]).toBe("/v1/coordination");
});
