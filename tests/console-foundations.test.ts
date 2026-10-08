import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { canonicalDeviceArguments } from "../apps/mcp-server/src/device-aliases.ts";
import { compactStructuredContent } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import { fleetSnapshot } from "../apps/mcp-server/src/fleet-snapshot.ts";

const inventory = [{ name: "lab-primary", aliases: ["lab"], url: "http://127.0.0.1:1", expectedAvailability: "intermittent" as const }];
const close: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (close.length) await close.pop()!(); });
async function harness(agent: AgentClient) {
  const server = new McpServer({ name: "synthetic", version: "1" });
  registerTools(server, agent);
  const client = new Client({ name: "synthetic-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  close.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("console foundation contracts", () => {
  it("rejects case-insensitive alias/name and Android collisions", () => {
    expect(() => new AgentClient([...inventory, { name: "LAB", url: "http://127.0.0.1:2" }])).toThrow(/Duplicate/);
    expect(() => new AgentClient([{ ...inventory[0]!, aliases: ["lab", "LAB"] }])).toThrow(/Duplicate/);
    const android = { descriptors: () => [{ name: "Lab", url: "android-reverse://Lab" }] };
    expect(() => new AgentClient(inventory, undefined, undefined, android as any)).toThrow(/Duplicate/);
    expect(new AgentClient(inventory).getDevice("LAB").name).toBe("lab-primary");
  });

  it("normalizes route fields and batches without editing arbitrary payload data", () => {
    const env = { device: "lab", devices: "lab" };
    const result = canonicalDeviceArguments({ sourceDevice: "LAB", destinationDevice: "lab-primary", devices: ["LAB"], items: [{ device: "lab", env }], env, request: { device: "lab" } }, inventory);
    expect(result).toEqual({ sourceDevice: "lab-primary", destinationDevice: "lab-primary", devices: ["lab-primary"], items: [{ device: "lab-primary", env }], env, request: { device: "lab" } });
  });

  it("canonicalizes MCP job references before dispatch without changing the durable key or environment", async () => {
    const agent = new AgentClient(inventory);
    const start = vi.spyOn(agent, "jobStart").mockResolvedValue({ id: "synthetic-job", state: "running" });
    const client = await harness(agent);
    for (const device of ["LAB", "lab-primary"]) {
      const result = await client.callTool({ name: "job_start", arguments: { device, identity: "root", command: "synthetic", idempotencyKey: "same-effect", env: { device: "LAB" } } });
      expect(result.isError).not.toBe(true);
    }
    expect(start).toHaveBeenCalledTimes(2);
    for (const args of start.mock.calls) {
      expect(args[0]).toBe("lab-primary");
      expect(args[1]).toMatchObject({ idempotencyKey: "same-effect", env: { device: "LAB" } });
    }
  });

  it("reports an unconfigured identity without probing another identity", async () => {
    const agent = new AgentClient(inventory);
    const probe = vi.spyOn(agent, "info");
    const client = await harness(agent);
    const result = await client.callTool({ name: "fleet_status", arguments: { devices: ["LAB"], identity: "owner" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ devices: [{ device: "lab-primary", identity: "owner", identityConfigured: false, configuredIdentities: ["root"], connectivity: "unknown", expectedAvailability: "intermittent" }] });
    expect(probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result.structuredContent)).not.toContain("budget");
  });

  it("rejects contradictory fleet selectors and retains the actual auto selection", async () => {
    const agent = new AgentClient(inventory);
    vi.spyOn(agent, "info").mockResolvedValue({ runtime: { ready: true } });
    vi.spyOn(agent, "requestRoute").mockResolvedValue({ totalMemoryBytes: 100, freeMemoryBytes: 25 });
    await expect(fleetSnapshot(agent, { identity: "owner", context: "system" })).rejects.toThrow(/Conflicting/);
    expect(await fleetSnapshot(agent, { identity: "auto" })).toMatchObject({ devices: [{ identity: "root", requestedIdentity: "auto", identityConfigured: true, endpointResponded: true, readiness: "ready" }] });
  });

  it.each([false, true])("distinguishes controller preview from agent capture (agent truncated=%s)", agentTruncated => {
    const receipt = { stdout: "x".repeat(80_000), stderr: "", stdoutTruncated: agentTruncated, stderrTruncated: false };
    const result = compactStructuredContent(receipt);
    expect(result).toMatchObject({ stdoutTruncated: true, agentStdoutTruncated: agentTruncated, agentStderrTruncated: false, controllerStdoutTruncated: true, controllerStderrTruncated: false });
    expect(receipt.stdout).toHaveLength(80_000);
    const agentOnly = { stdout: "small", stderr: "", stdoutTruncated: true, stderrTruncated: false };
    expect(compactStructuredContent(agentOnly)).toEqual(agentOnly);
  });
});
