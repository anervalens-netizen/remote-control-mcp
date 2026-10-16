import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ExecReceiptStore } from "../apps/agent/src/exec-receipts.ts";
import { registerExecRoutes } from "../apps/agent/src/exec-routes.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { nativeCommand } from "../apps/agent/src/shell-quote.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function harness() {
  const root = mkdtempSync(path.join(os.tmpdir(), "exec-receipt-http-"));
  closers.push(async () => rmSync(root, { recursive: true, force: true }));
  const agent = Fastify(); registerExecRoutes(agent, new ExecReceiptStore(path.join(root, "receipts")));
  let supported = true;
  agent.get("/v1/info", async () => ({ runtime: { capabilities: supported ? ["exec-receipts-v1"] : [] } }));
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => agent.close());
  const connection = async () => {
    const server = new McpServer({ name: "fixture", version: "1" });
    registerTools(server, new AgentClient([{ name: "fixture", url, userUrl: url }]));
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(async () => { await client.close(); await server.close(); });
    await client.listTools();
    return client;
  };
  return { root, url, connection, unsupported: () => { supported = false; } };
}
function data(result: any): any {
  if (result.isError) throw new Error(JSON.stringify(result));
  return result.structuredContent ?? JSON.parse(result.content.find((c: any) => c.type === "text").text);
}
it("recovers through a fresh MCP controller, validates schemas and refuses duplicate effects", async () => {
  const h = await harness(), first = await h.connection();
  const ref = data(await first.callTool({ name: "exec_prepare", arguments: { device: "fixture", identity: "owner" } }));
  const effect = path.join(h.root, "effect"), script = path.join(h.root, "effect.cjs");
  writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(effect)},"once");console.log("receipt");`);
  const args = { device: "fixture", identity: "owner", command: nativeCommand([process.execPath, script]), execReceiptId: ref.id };
  expect(data(await first.callTool({ name: "exec", arguments: args })).code).toBe(0);
  await first.close();
  const second = await h.connection();
  const recovered = data(await second.callTool({ name: "exec_recover", arguments: { device: "fixture", identity: "owner", id: ref.id } }));
  expect(recovered.state).toBe("complete");
  expect(JSON.parse(Buffer.from(recovered.data, "base64").toString()).stdout).toContain("receipt");
  expect((await second.callTool({ name: "exec", arguments: args })).isError).toBe(true);
  expect(readFileSync(effect, "utf8")).toBe("once");
  h.unsupported();
  const ref2 = data(await second.callTool({ name: "exec_prepare", arguments: { device: "fixture", identity: "owner" } }));
  expect((await second.callTool({ name: "exec", arguments: { ...args, execReceiptId: ref2.id } })).isError).toBe(true);
  expect(readFileSync(effect, "utf8")).toBe("once");
}, 30000);
it("persists the cancellation receipt after the HTTP caller disconnects", async () => {
  const h = await harness();
  const post = async (route: string, body: unknown) => fetch(h.url + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ref = await (await post("/v1/exec/prepare", {})).json() as { id: string };
  const ready = path.join(h.root, "ready"), script = path.join(h.root, "wait.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(ready)},"once");setInterval(()=>{},1000);`);
  const controller = new AbortController();
  const pending = fetch(h.url + "/v1/exec", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: nativeCommand([process.execPath, script]), execReceiptId: ref.id, timeoutMs: 20000 }), signal: controller.signal });
  void pending.catch(() => {});
  try {
    const deadline = Date.now() + 15000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(existsSync(ready)).toBe(true);
  } finally { controller.abort(); await pending.catch(() => {}); }
  let receipt: any;
  const deadline = Date.now() + 10000;
  do {
    receipt = await (await post("/v1/exec/recover", { id: ref.id })).json();
    if (receipt.state === "complete") break;
    await new Promise(r => setTimeout(r, 50));
  } while (Date.now() < deadline);
  expect(receipt.state).toBe("complete");
  expect(JSON.parse(Buffer.from(receipt.data, "base64").toString())).toMatchObject({ cancellationRequested: true });
  expect(readFileSync(ready, "utf8")).toBe("once");
}, 40000);
