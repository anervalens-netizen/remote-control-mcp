import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerAdvancedTools } from "../apps/mcp-server/src/advanced-tools.ts";
import { registerSearchSessionTools } from "../apps/mcp-server/src/search-tools.ts";

it("advertises and forwards traversal options on both MCP search surfaces", async () => {
  const calls: unknown[][] = [];
  const fake = { requestRoute: async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true };
  }} as unknown as AgentClient;
  const server = new McpServer({ name: "search-test", version: "1" });
  registerAdvancedTools(server, fake);
  registerSearchSessionTools(server, fake);
  const client = new Client({ name: "search-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const options = {
      path: "/fixture", pattern: "needle", mode: "content",
      glob: "*.ts", globs: ["src/**", "!vendor/**"],
      types: ["ts"], excludeTypes: ["json"], follow: true, noIgnore: true,
      maxFileSizeBytes: 4096, maxResults: 10, literal: true, hidden: true, ignoreCase: true,
    };
    const listed = await client.listTools();
    for (const [name, route] of [["search", "/v1/search"], ["search_start", "/v1/search/start"]]) {
      const schema = listed.tools.find((tool) => tool.name === name)!.inputSchema;
      for (const key of Object.keys(options)) expect(schema.properties).toHaveProperty(key);
      const response = await client.callTool({ name: name!, arguments: { device: "pc", context: "user", ...options } });
      expect(response.isError).not.toBe(true);
      expect(calls.at(-1)).toEqual(["pc", route, options, "user"]);
      const count = calls.length;
      const invalid = await client.callTool({ name: name!, arguments: { device: "pc", ...options, maxFileSizeBytes: -1 } });
      expect(invalid.isError).toBe(true);
      expect(calls).toHaveLength(count);
    }
  } finally {
    await client.close();
    await server.close();
  }
});
