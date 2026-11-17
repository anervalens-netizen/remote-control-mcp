import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import { registerTools } from "../apps/mcp-server/src/tools.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["capability", "file"] as const)("forwards actual SDK cancellation during the %s phase of a single fs_read", async phase => {
  const entered = Promise.withResolvers<void>();
  let signal: AbortSignal | null | undefined;
  let release: (() => void) | undefined;
  const routes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
    const route = new URL(url).pathname;
    routes.push(route);
    if (phase === "file" && route === "/v1/info") return Response.json({ runtime: { capabilities: ["utf8-byte-pages-v1"] } });
    signal = options.signal;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      release = () => { signal?.removeEventListener("abort", abort); resolve(Response.json({ data: "fixture" })); };
      entered.resolve();
    });
  }));
  const agent = new AgentClient([{ name: "fixture", url: "http://fixture.invalid" }], undefined, 1000);
  const server = new McpServer({ name: "single-read-cancellation", version: "1" });
  registerTools(server, agent);
  const sdk = new Client({ name: "single-read-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const caller = new AbortController();
  try {
    await Promise.all([server.connect(st), sdk.connect(ct)]);
    const pending = sdk.callTool({ name: "fs_read", arguments: {
      device: "fixture", identity: "root", path: "fixture.txt", encoding: "utf8", offset: 0, length: 4,
    } }, undefined, { signal: caller.signal });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    caller.abort(new DOMException("Synthetic caller cancelled", "AbortError"));
    await rejection;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 200, interval: 10 });
    await vi.waitFor(() => expect(dispatchesFor(agent).snapshot().total.cancelled).toBe(1), { timeout: 200, interval: 10 });
    expect(dispatchesFor(agent).snapshot().total.timeouts).toBe(0);
    expect(routes).toEqual(phase === "capability" ? ["/v1/info"] : ["/v1/info", "/v1/fs/read"]);
  } finally {
    release?.();
    await sdk.close(); await server.close();
  }
});
