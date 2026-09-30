import { afterEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ closeBridge: vi.fn(), closeServer: vi.fn(), connect: vi.fn(), register: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: class { close = hooks.closeServer; connect = hooks.connect; } }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));
vi.mock("../apps/mcp-server/src/agent-client.ts", () => ({ AgentClient: class {} }));
vi.mock("../apps/mcp-server/src/all-tools.ts", () => ({ registerTools: hooks.register }));
vi.mock("../apps/mcp-server/src/contextkeep-bridge.ts", () => ({ closeContextKeepBridges: hooks.closeBridge }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.resetModules(); });

it.each(["SIGINT", "SIGTERM", "end"])("drains bridge activity before closing stdio on %s, without duplicate shutdown", async event => {
  const handlers = new Map<string, () => void>();
  vi.spyOn(process, "once").mockImplementation(((name: string, callback: () => void) => { handlers.set(name, callback); return process; }) as typeof process.once);
  vi.spyOn(process.stdin, "once").mockImplementation(((name: string, callback: () => void) => { handlers.set(name, callback); return process.stdin; }) as typeof process.stdin.once);
  let drained!: () => void;
  hooks.closeBridge.mockImplementation(() => new Promise<void>(resolve => { drained = resolve; }));
  hooks.connect.mockResolvedValue(undefined); hooks.closeServer.mockResolvedValue(undefined);
  await import("../apps/mcp-server/src/stdio.ts");
  expect(hooks.register).toHaveBeenCalledTimes(1);
  handlers.get(event)!(); handlers.get(event)!();
  expect(hooks.closeBridge).toHaveBeenCalledTimes(1);
  expect(hooks.closeServer).not.toHaveBeenCalled();
  drained();
  await vi.waitFor(() => expect(hooks.closeServer).toHaveBeenCalledTimes(1));
});
