import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** Socket closure alone does not delete the server-side MCP session. */
export async function closeMcpValidation(client: Client, transport: StreamableHTTPClientTransport): Promise<void> {
  try { await transport.terminateSession(); }
  finally { await client.close(); }
}
