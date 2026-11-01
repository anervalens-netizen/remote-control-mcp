import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { collectRefs, SemanticDesktop } from "../apps/agent/src/semantic-desktop.ts";
import { semanticActSchema, type SemanticManifest } from "../packages/protocol/src/semantic-desktop.ts";
import Fastify from "fastify";
import { registerSemanticDesktopRoutes } from "../apps/agent/src/semantic-desktop-routes.ts";
import { registerSemanticDesktopTools } from "../apps/mcp-server/src/semantic-desktop-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "semantic-desktop-test-")); roots.push(root);
  let binding = "session-one", effects = 0, uncertain = false, complete = true;
  const calls: string[][] = [];
  const manifest: SemanticManifest = { version: 1, engineVersion: "1.0.2", jsonVersion: "2.5", binary: path.join(root, "native"), sha256: "a".repeat(64), files: [], provenanceVerified: true };
  const deps = { root, manifest: () => manifest, session: async () => ({ env: {}, fingerprint: binding }), invoke: async (_: unknown, args: string[]) => {
    calls.push(args);
    if (args[0] === "snapshot") return { version: "2.5", ok: true, data: { complete, tree: { name: "Synthetic entry", ref_id: "@synthetic:e1" } } };
    effects++;
    if (uncertain) throw new Error("transport lost after effect");
    return { version: "2.5", ok: true, data: { disposition: { delivery: "delivered_unverified", retry: "unsafe" } } };
  } };
  return { root, deps, backend: new SemanticDesktop(deps), calls, effects: () => effects, session: (s: string) => { binding = s; }, uncertain: () => { uncertain = true; }, partial: () => { complete = false; } };
}
async function actionInput(s: ReturnType<typeof setup>, extra = {}) {
  const obs = await s.backend.observe({ app: "Synthetic fixture" });
  return { commandId: randomUUID(), observationId: obs.observationId, ref: "@synthetic:e1", action: "click", ...extra };
}
it("persists effects and recovers duplicates after a backend restart without replay", async () => {
  const s = setup(), input = await actionInput(s);
  const first = await s.backend.act(input);
  expect(first).toMatchObject({ ok: true, applicationEffectVerified: false, data: { disposition: { delivery: "delivered_unverified" } } });
  expect(first.observation.observationId).toBeTruthy();
  const second = await new SemanticDesktop(s.deps).act(input);
  expect(second).toMatchObject({ recovered: true, replayed: false });
  expect(s.effects()).toBe(1);
});
it("serializes concurrent submissions of one command", async () => {
  const s = setup(), input = await actionInput(s);
  await Promise.all([s.backend.act(input), s.backend.act(input)]);
  expect(s.effects()).toBe(1);
});
it("rejects command ID reuse with a different effect", async () => {
  const s = setup(), input = await actionInput(s);
  await s.backend.act(input);
  expect(await s.backend.act({ ...input, action: "toggle" })).toMatchObject({ error: { code: "command_id_conflict" } });
  expect(s.effects()).toBe(1);
});
it("does not replay after native timeout or uncertainty", async () => {
  const s = setup(), input = await actionInput(s); s.uncertain();
  expect(await s.backend.act(input)).toMatchObject({ error: { disposition: { delivery: "delivery_uncertain", retry: "unsafe" } } });
  expect(await s.backend.act({ mode: "status", commandId: input.commandId })).toMatchObject({ recovered: true, error: { disposition: { retry: "unsafe" } } });
  await s.backend.act(input); expect(s.effects()).toBe(1);
});
it("retains an unfinished durable reservation as unknown", async () => {
  const s = setup(), input = await actionInput(s); await s.backend.act(input);
  const file = path.join(s.root, "commands", `${input.commandId}.json`);
  const receipt = JSON.parse(readFileSync(file, "utf8")); delete receipt.result; writeFileSync(file, JSON.stringify(receipt));
  expect(await new SemanticDesktop(s.deps).act(input)).toMatchObject({ error: { code: "command_outcome_unknown" } });
  expect(s.effects()).toBe(1);
});
it.each(["session", "binary", "ref", "expired"])("refuses stale %s before dispatch", async reason => {
  const s = setup(), input = await actionInput(s);
  if (reason === "session") s.session("new session");
  if (reason === "binary") s.deps.manifest().sha256 = "b".repeat(64);
  if (reason === "ref") input.ref = "@synthetic:e999";
  if (reason === "expired") {
    const file = path.join(s.root, "observations", `${input.observationId}.json`);
    const obs = JSON.parse(readFileSync(file, "utf8")); obs.createdAt = 0; writeFileSync(file, JSON.stringify(obs));
  }
  expect(await s.backend.act(input)).toMatchObject({ ok: false, error: { disposition: { delivery: "not_delivered" } } });
  expect(s.effects()).toBe(0);
});
it("keeps value content literal, including CLI options and shell metacharacters", async () => {
  const s = setup(), value = "--headed $(do-not-run) '😀'";
  await s.backend.act(await actionInput(s, { action: "set-value", value }));
  const call = s.calls.find(c => c[0] === "set-value")!;
  expect(call.slice(call.indexOf("--") + 1)).toEqual(["@synthetic:e1", value]);
  expect(call).not.toContain("--headed");
});
it("preserves partial snapshots and requires observation binding for drill-down", async () => {
  const s = setup(); s.partial();
  const result = await s.backend.observe({ app: "fixture" });
  expect(result.data.complete).toBe(false);
  expect(await s.backend.observe({ ref: "@synthetic:e1" })).toMatchObject({ error: { code: "observation_id_required" } });
});
it("validates routes and does not dispatch invalid requests", async () => {
  const s = setup(), app = Fastify(); registerSemanticDesktopRoutes(app, s.backend);
  try {
    const r = await app.inject({ method: "POST", url: "/v1/desktop/act", payload: { commandId: "../../escape", action: "click" } });
    expect(r.statusCode).toBe(400); expect(s.effects()).toBe(0);
    expect(semanticActSchema.safeParse({ commandId: randomUUID(), action: "shell" }).success).toBe(false);
  } finally { await app.close(); }
});
it.each(["user", "desktop"] as const)("routes actual MCP calls through the %s endpoint and recovers a command", async context => {
  const s = setup(), agent = Fastify();
  agent.get("/v1/info", () => ({ runtime: { capabilities: ["desktop-semantic-v1"] } }));
  registerSemanticDesktopRoutes(agent, s.backend);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  const server = new McpServer({ name: "semantic-test", version: "1" }), client = new Client({ name: "test", version: "1" });
  registerSemanticDesktopTools(server, new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1", ...(context === "desktop" ? { desktopUrl: url } : { userUrl: url }) }]));
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result: any = await client.callTool({ name: "desktop_observe", arguments: { device: "fixture", app: "Synthetic fixture" } });
    const obs = JSON.parse(result.content[0].text);
    expect(obs.observationId).toBeTruthy();
    const args = { device: "fixture", commandId: randomUUID(), observationId: obs.observationId, ref: "@synthetic:e1", action: "click" };
    await client.callTool({ name: "desktop_act", arguments: args });
    const recovered: any = await client.callTool({ name: "desktop_act", arguments: args });
    expect(JSON.parse(recovered.content[0].text).recovered).toBe(true);
    expect(s.effects()).toBe(1);
  } finally { await client.close(); await server.close(); await agent.close(); }
});

it("does not accept reference-shaped UI text as an actionable element", () => {
  expect(collectRefs({ tree: [{ ref_id: "@synthetic:e1", name: "@synthetic:e2" }] })).toEqual(["@synthetic:e1"]);
});
