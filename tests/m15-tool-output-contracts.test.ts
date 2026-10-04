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
    expect(listed.tools).toHaveLength(96);
    expect(listed.tools.filter(t => ["batch_recover", "diagnostic_wait_report"].includes(t.name)).map(t => t.name).sort()).toEqual(["batch_recover", "diagnostic_wait_report"]);
    expect(listed.tools.filter(t => t.name.startsWith("result_recover")).map(t => t.name).sort()).toEqual(["result_recover", "result_recovery_prepare", "result_recovery_release"]);
    expect(listed.tools.filter((tool) => !tool.outputSchema).map((tool) => tool.name)).toEqual([]);
  } finally {
    await client.close();
    await server.close();
  }
});
