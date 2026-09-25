import { agentInstructions } from "./instructions.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentClient } from "./agent-client.ts";
import { registerTools } from "./all-tools.ts";

// Stdio servers are spawned per MCP client. They must never own the singleton
// phone-facing Android listener from RCMCP_ANDROID_CONFIG; the persistent HTTP
// controller/canary owns that reverse channel. Android-specific tools are
// therefore intentionally absent from the stdio surface.
const server = new McpServer(
  { name: "remote-control-mcp", version: "0.1.0" },
  { instructions: agentInstructions },
);
registerTools(server, new AgentClient());

const transport = new StdioServerTransport();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
process.stdin.once("end", () => { void close(); });
await server.connect(transport);
