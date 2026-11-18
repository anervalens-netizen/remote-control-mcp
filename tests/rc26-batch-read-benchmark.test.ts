import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools as registerCoreTools } from "../apps/mcp-server/src/tools.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

afterEach(() => vi.restoreAllMocks());

it("batches independent owner/root reads in one SDK roundtrip without losing per-item identity or failures", async () => {
  const agent = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1",
    userUrl: "http://127.0.0.1:2" }]);
  vi.spyOn(agent, "info").mockResolvedValue({ runtime: { capabilities: ["utf8-byte-pages-v1"] } });
  let active = 0, peak = 0;
  const calls: Array<{ path: string; context: string }> = [];
  vi.spyOn(agent, "fsRead").mockImplementation(async (_device, input, context) => {
    const request = input as { path: string };
    active++; peak = Math.max(peak, active);
    calls.push({ path: request.path, context: context ?? "system" });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (request.path === "/missing") throw new Error("missing synthetic file");
      const value = context === "user" ? "owner" : "root";
      return { path: request.path, data: value, encoding: "utf8",
        bytesRead: value.length, totalBytes: value.length, offset: 0,
        nextOffset: value.length, eof: true };
    } finally { active--; }
  });

  const server = new McpServer({ name: "batch-read-fixture", version: "1" });
  registerCoreTools(server, agent);
  registerHighLevelTools(server, agent);
  const sdk = new Client({ name: "batch-read-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(left), sdk.connect(right)]);
    const items = [
      { device: "fixture", path: "/a", identity: "owner" },
      { device: "fixture", path: "/b", identity: "root" },
      { device: "fixture", path: "/c", identity: "owner" },
      { device: "fixture", path: "/missing", identity: "root" },
    ];
    // Four independent baseline tool calls, no effectful action or retry.
    const baseline = [];
    let baselineRounds = 0;
    for (const item of items) {
      baselineRounds++;
      baseline.push(await sdk.callTool({ name: "fs_read", arguments: item }));
    }
    expect(baselineRounds).toBe(4);
    expect(calls).toEqual([
      { path: "/a", context: "user" }, { path: "/b", context: "system" },
      { path: "/c", context: "user" }, { path: "/missing", context: "system" },
    ]);
    calls.length = 0;
    peak = 0;
    const batched = await sdk.callTool({ name: "batch_read", arguments: { items, concurrency: 2 } });
    expect(batched.isError).not.toBe(true);
    expect(batched.structuredContent).toMatchObject({ partial: true, items: [
      { index: 0, identity: "owner", context: "user", ok: true, result: { data: "owner" } },
      { index: 1, identity: "root", context: "system", ok: true, result: { data: "root" } },
      { index: 2, identity: "owner", context: "user", ok: true, result: { data: "owner" } },
      { index: 3, identity: "root", context: "system", ok: false },
    ] });
    expect(calls).toHaveLength(4);
    expect(peak).toBe(2);
    expect(batched.structuredContent).toMatchObject({ errors: [
      { index: 3, ok: false, device: "fixture", identity: "root", context: "system" },
    ] });
    // Work is equivalent, but the client submitted 1 vs 4 MCP messages.
    expect({ baselineRounds, batchedRounds: 1 }).toEqual({ baselineRounds: 4, batchedRounds: 1 });
  } finally { await sdk.close(); await server.close(); }
});
