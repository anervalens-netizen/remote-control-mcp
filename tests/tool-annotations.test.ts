import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { expect, it } from "vitest";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";

it("advertises accurate read hints without relabeling effectful tools or overriding explicit metadata", async () => {
  const server = new McpServer({ name: "synthetic-annotations", version: "1" });
  const client = new Client({ name: "synthetic-client", version: "1" });
  installDefaultToolOutputContracts(server);
  for (const name of ["device_info", "fs_list", "exec", "fs_manage", "job_start"]) {
    server.registerTool(name, { inputSchema: {} }, async () => ({ content: [] }));
  }
  server.registerTool("fs_read", { inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: true } }, async () => ({ content: [] }));
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(left), client.connect(right)]);
    const { tools } = await client.listTools();
    const metadata = new Map(tools.map(tool => [tool.name, tool.annotations]));
    expect(metadata.get("device_info")).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(metadata.get("fs_list")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const name of ["exec", "fs_manage", "job_start"]) expect(metadata.get(name)?.readOnlyHint).not.toBe(true);
    expect(metadata.get("fs_read")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.every(tool => tool.outputSchema)).toBe(true);
  } finally {
    await client.close(); await server.close();
  }
});
