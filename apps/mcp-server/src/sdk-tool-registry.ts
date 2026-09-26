// Compatibility boundary for the pinned MCP SDK. Keep session transports separate.
// A deliberate SDK upgrade must run the adapter and session-isolation tests.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
type Registry = Record<string, unknown>;
type Internals = { _registeredTools: Registry; setToolRequestHandlers(): void };
function internals(server: McpServer): Internals {
  const value = server as unknown as Partial<Internals>;
  if (!value._registeredTools || typeof value._registeredTools !== "object" || Array.isArray(value._registeredTools)
    || typeof value.setToolRequestHandlers !== "function") {
    throw new Error("MCP SDK tool registry internals are incompatible with session reuse");
  }
  return value as Internals;
}
export function readToolRegistry(server: McpServer): Registry { return internals(server)._registeredTools; }
export function installToolRegistry(server: McpServer, registry: Registry): void {
  const target = internals(server);
  target._registeredTools = registry;
  target.setToolRequestHandlers();
}
