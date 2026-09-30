import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient, AgentEndpointContext } from "../apps/mcp-server/src/agent-client.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { compactStructuredContent, installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

function fakeClient(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ device: string; context: AgentEndpointContext }> = [];
  const client = {
    configuredContexts: (device: string) => ({ system: true, user: device !== "offline", desktop: device !== "offline" }),
    jobStart: async (device: string, _input: unknown, context: AgentEndpointContext) => {
      calls.push({ device, context });
      return { id: `${device}-job`, pid: 101, state: "running" };
    },
    ...overrides,
  } as unknown as AgentClient;
  return { client, calls };
}

async function jobHarness(client: AgentClient) {
  const server = new McpServer({ name: "m16-contracts", version: "1" });
  installDefaultToolOutputContracts(server);
  registerJobTools(server, client);
  const mcp = new Client({ name: "m16-contracts-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  closers.push(async () => { await mcp.close(); await server.close(); });
  return mcp;
}

describe("M16 contract lane", () => {
  it("keeps all 89 core contracts plus four optional Android contracts and rejects empty results", () => {
    const names = Object.keys(toolResultSchemas);
    expect(names.filter(name => !name.startsWith("android_"))).toHaveLength(89);
    expect(names.filter(name => name.startsWith("android_")).sort()).toEqual([
      "android_action", "android_command_status", "android_observe", "android_status",
    ]);
    for (const [name, schema] of Object.entries(toolResultSchemas)) {
      expect(schema.safeParse({}).success, `${name} accepts an empty semantic result`).toBe(false);
    }
  });

  it("rejects malformed semantic results for lifecycle, writes, transfers, search, deploy and desktop", () => {
    expect(toolResultSchemas.job_start.safeParse({ identity: "root", context: "system", state: "running" }).success).toBe(false);
    expect(toolResultSchemas.fs_write.safeParse({ path: "/tmp/x", bytes: 1, mode: "rewrite", atomic: true, durable: true }).success).toBe(false);
    expect(toolResultSchemas.file_transfer.safeParse({ sourceDevice: "a", destinationDevice: "b", bytes: 1, chunks: 1, sameFile: false, atomic: true, durationMs: 1 }).success).toBe(false);
    expect(toolResultSchemas.search_results.safeParse({ id: "s", status: "done", results: [], available: 0 }).success).toBe(false);
    expect(toolResultSchemas.deploy_run.safeParse({ identity: "root", context: "system" }).success).toBe(false);
    expect(toolResultSchemas.desktop_screenshot.safeParse({ width: 100, height: 100 }).success).toBe(false);
  });

  it("uses explicit identity over legacy context and publishes the resolved route", async () => {
    const { client, calls } = fakeClient();
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start", arguments: {
      device: "pc", command: "echo ok", identity: "owner", context: "system", elevation: "never",
    } });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([{ device: "pc", context: "user" }]);
    expect(result.structuredContent).toMatchObject({ id: "pc-job", identity: "owner", context: "user" });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ id: "pc-job", state: "running" });
  });

  it("publishes canonical routing fields on every job tool and keeps the schemas strict", async () => {
    const { client } = fakeClient();
    const mcp = await jobHarness(client);
    const listed = await mcp.listTools();
    const jobNames = ["job_start", "job_start_many", "job_status", "job_output", "job_wait", "job_output_since", "job_cancel", "job_list", "job_lineage", "job_remove"];
    for (const name of jobNames) {
      const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema as { properties?: Record<string, unknown>; additionalProperties?: boolean };
      expect(schema.properties, name).toEqual(expect.objectContaining({ identity: expect.any(Object), elevation: expect.any(Object), context: expect.any(Object) }));
      expect(schema.additionalProperties, name).toBe(false);
    }
  });

  it("rejects unknown job input fields before effects", async () => {
    const { client, calls } = fakeClient();
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start", arguments: { device: "pc", command: "echo never", unexpected: true } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("preflights every job_start_many target before dispatch", async () => {
    const { client, calls } = fakeClient();
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start_many", arguments: {
      devices: ["pc", "offline"], command: "echo never", identity: "owner",
    } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("retains legacy array TextContent while adding routed structured content for batches", async () => {
    const { client } = fakeClient();
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start_many", arguments: {
      devices: ["pc"], command: "echo ok", identity: "owner",
    } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual([
      { device: "pc", context: "user", ok: true, job: { id: "pc-job", pid: 101, state: "running" } },
    ]);
    expect(result.structuredContent).toMatchObject({ identity: "owner", context: "user", items: [{ device: "pc", identity: "owner", context: "user", ok: true }] });
  });
});


describe("heterogeneous automatic batches", () => {
  const configuredContexts = (device: string) => ({ system: device !== "owner-only", user: true, desktop: false });

  it.each([["owner-only", "dual"], ["dual", "owner-only"]])("keeps each resolved identity for %s then %s", async (first, second) => {
    const { client, calls } = fakeClient({ configuredContexts });
    const mcp = await jobHarness(client);
    const devices = [first, second];
    const result = await mcp.callTool({ name: "job_start_many", arguments: { devices, command: "synthetic", concurrency: 1 } });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual(devices.map(device => ({ device, context: device === "owner-only" ? "user" : "system" })));
    const structured = result.structuredContent as { items: Array<{ device: string; identity: string; context: string }> };
    expect(structured.items.map(({ device, identity, context }) => ({ device, identity, context }))).toEqual(
      devices.map(device => ({ device, identity: device === "owner-only" ? "owner" : "root", context: device === "owner-only" ? "user" : "system" })),
    );
    expect(structured).not.toHaveProperty("identity");
    expect(structured).not.toHaveProperty("context");
  });

  it("retains homogeneous metadata for explicit owner on differently configured devices", async () => {
    const { client, calls } = fakeClient({ configuredContexts });
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start_many", arguments: { devices: ["owner-only", "dual"], command: "synthetic", identity: "owner", concurrency: 1 } });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([{ device: "owner-only", context: "user" }, { device: "dual", context: "user" }]);
    expect(result.structuredContent).toMatchObject({ identity: "owner", context: "user" });
  });

  it("rejects unavailable explicit root before dispatching even the valid first device", async () => {
    const { client, calls } = fakeClient({ configuredContexts });
    const mcp = await jobHarness(client);
    const result = await mcp.callTool({ name: "job_start_many", arguments: { devices: ["dual", "owner-only"], command: "synthetic", identity: "root" } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});


it("rejects empty batches and dishonest summary routing without throwing", () => {
  const item = { device: "fixture", identity: "owner", context: "user", ok: true, job: { id: "fixture-job", state: "running" } };
  expect(toolResultSchemas.job_start_many.safeParse({ items: [] }).success).toBe(false);
  expect(toolResultSchemas.job_start_many.safeParse({ items: [item], identity: "root", context: "system" }).success).toBe(false);
  expect(toolResultSchemas.job_start_many.safeParse({ items: [{ ...item, identity: "root" }], identity: "root", context: "user" }).success).toBe(false);
  expect(toolResultSchemas.job_start_many.safeParse({ items: [item] }).success).toBe(true);
});

it("preserves truthful per-item routing when a large mixed batch is compacted", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    device: `fixture-${index}`, identity: index === 99 ? "root" : "owner", context: index === 99 ? "system" : "user", ok: true,
    job: { id: `fixture-job-${index}`, state: "running", detail: "synthetic".repeat(1000) },
  }));
  const compacted = compactStructuredContent({ items }, 4096, toolResultSchemas.job_start_many);
  expect(compacted.structuredContentTruncated).toBe(true);
  expect(compacted).not.toHaveProperty("identity");
  expect(compacted).not.toHaveProperty("context");
  expect(toolResultSchemas.job_start_many.safeParse(compacted).success).toBe(true);
});
