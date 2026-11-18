import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function fixture() {
  const agent = Fastify();
  const effects: Array<{ key: string; command: string }> = [];
  // Count every inbound start attempt before keyed deduplication. A hidden
  // controller replay must not look like one effect simply because the agent
  // coalesced multiple requests.
  const startRequests: Array<{ key: string; command: string }> = [];
  const jobs = new Map<string, { id: string; state: "completed"; exitCode: 0; command: string }>();
  const id = "00000000-0000-4000-8000-000000000401";
  agent.post("/v1/jobs/start", async request => {
    const { idempotencyKey, command } = request.body as { idempotencyKey: string; command: string };
    if (!idempotencyKey) throw new Error("durable effect identity required");
    startRequests.push({ key: idempotencyKey, command });
    const previous = jobs.get(idempotencyKey);
    if (previous) {
      if (previous.command !== command) throw new Error("key-conflict");
      return previous;
    }
    effects.push({ key: idempotencyKey, command });
    const job = { id, state: "completed" as const, exitCode: 0 as const, command };
    jobs.set(idempotencyKey, job);
    return job;
  });
  agent.post("/v1/jobs/status", async request => {
    const { id: selected, idempotencyKey } = request.body as { id?: string; idempotencyKey?: string };
    const job = idempotencyKey ? jobs.get(idempotencyKey) : [...jobs.values()].find(j => j.id === selected);
    return !job ? { state: "not_found" } : idempotencyKey ? { state: "resolved", jobId: job.id, job } : job;
  });
  agent.post("/v1/jobs/follow", async request => {
    const { id: selected } = request.body as { id: string };
    const job = [...jobs.values()].find(j => j.id === selected);
    return !job ? { state: "not_found" } : {
      ...job, terminal: true, waitExpired: false, outputComplete: true,
      cursor: { stdout: 0, stderr: 0 }, stdout: { data: "" }, stderr: { data: "" },
    };
  });
  const agentUrl = await agent.listen({ host: "127.0.0.1", port: 0 });
  closers.push(async () => { agent.server.closeAllConnections(); await agent.close(); });
  const http = createMcpHttpServer(new AgentClient([{ name: "synthetic", url: agentUrl, userUrl: agentUrl }]), { token: "rc26-fixture-only" });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  return { effects, startRequests, jobs, id, url: new URL("http://127.0.0.1:" + (http.address() as { port: number }).port + "/mcp") };
}

const auth = "Bearer rc26-fixture-only";
const jsonHeaders = { Authorization: auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const input = (key: string) => ({ device: "synthetic", identity: "owner", command: "synthetic-once", idempotencyKey: key });

async function sdk(url: URL, faultyFetch?: typeof fetch) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: auth } },
    ...(faultyFetch ? { fetch: faultyFetch } : {}),
  });
  const client = new Client({ name: "rc26-mcp04-transport", version: "1" });
  await client.connect(transport);
  closers.push(async () => { await client.close().catch(() => {}); });
  return client;
}

describe("RC26-MCP-04 lost-response no-replay transport evidence", () => {
  it("drops a completed job_start HTTP reply and recovers via a new SDK client reading the original durable key", async () => {
    const f = await fixture(), key = "sdk-lost-delivery";
    let dropped = 0;
    const faultFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      const body = typeof init?.body === "string" ? init.body : "";
      if (dropped === 0 && body.includes('"name":"job_start"')) {
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        dropped++;
        throw new Error("synthetic_lost_completed_response");
      }
      return response;
    };
    const first = await sdk(f.url, faultFetch);
    await expect(first.callTool({ name: "job_start", arguments: input(key) })).rejects.toThrow();
    expect(dropped).toBe(1);
    expect(f.effects).toEqual([{ key, command: "synthetic-once" }]);
    const restored = await sdk(f.url);
    const status = await restored.callTool({ name: "job_status", arguments: {
      device: "synthetic", identity: "owner", idempotencyKey: key,
    } });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ state: "resolved", jobId: f.id,
      job: { id: f.id, state: "completed", exitCode: 0 } });
    // Read the resolved job by its recovered identity, without asking the
    // agent to start the effect again or substituting a new request ID.
    const persisted = await restored.callTool({ name: "job_status", arguments: {
      device: "synthetic", identity: "owner", id: f.id,
    } });
    expect(persisted.isError).not.toBe(true);
    expect(persisted.structuredContent).toMatchObject({ id: f.id, state: "completed", exitCode: 0 });
    expect(f.effects).toHaveLength(1);
    expect(f.startRequests).toEqual([{ key, command: "synthetic-once" }]);
  }, 20_000);

  for (const legacy of [false, true] as const) {
    it((legacy ? "legacy stateless SSE" : "modern stateless JSON") + " recovers after lost response and changed JSON-RPC ID", async () => {
      const f = await fixture(), key = legacy ? "legacy-response-loss" : "modern-response-loss";
      async function call(method: string, params: Record<string, unknown>, id: string, dropCompletedResponse = false) {
        const headers = {
          ...jsonHeaders, ...(legacy ? {} : {
            "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method,
            ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
          }),
        };
        const metadata = { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test-only-client", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {} };
        const response = await fetch(f.url, { method: "POST", headers,
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: legacy ? params : { ...params, _meta: metadata } }),
        });
        expect(response.status).toBe(200);
        if (dropCompletedResponse) {
          await response.arrayBuffer();
          throw new Error("synthetic_lost_client_reply_after_dispatch");
        }
        const payload = await response.text();
        const envelope = legacy ? JSON.parse(payload.split("\n").find(line => line.startsWith("data:"))!.slice(5)) : JSON.parse(payload);
        return envelope as { id: string; result: { isError?: boolean; structuredContent: Record<string, unknown> } };
      }
      // Server finishes dispatch, but the simulated client loses the first
      // response before its JSON-RPC envelope is delivered or parsed.
      await expect(call("tools/call", { name: "job_start", arguments: input(key) }, "first-id-47", true))
        .rejects.toThrow("synthetic_lost_client_reply_after_dispatch");
      expect(f.effects).toHaveLength(1);
      const recovered = await call("tools/call", { name: "job_status", arguments: {
        device: "synthetic", identity: "owner", idempotencyKey: key,
      } }, "second-id-712");
      expect(recovered.id).toBe("second-id-712");
      expect(recovered.result.isError).not.toBe(true);
      expect(recovered.result.structuredContent).toMatchObject({ state: "resolved", jobId: f.id });
      expect(f.effects).toEqual([{ key, command: "synthetic-once" }]);
      expect(f.startRequests).toEqual([{ key, command: "synthetic-once" }]);
    }, 20_000);
  }
});
