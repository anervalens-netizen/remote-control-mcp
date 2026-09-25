import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

it("publishes an output contract for every registered MCP tool", async () => {
  const server = new McpServer({ name: "m15-tool-contracts", version: "1" });
  registerTools(server, new AgentClient([]));
  const client = new Client({ name: "m15-tool-contracts-client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(89);
    expect(listed.tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name)).toEqual([]);
  } finally {
    await client.close();
    await server.close();
  }
});
