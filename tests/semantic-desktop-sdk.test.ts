import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { SemanticDesktop } from "../apps/agent/src/semantic-desktop.ts";
import { registerSemanticDesktopRoutes } from "../apps/agent/src/semantic-desktop-routes.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import type { SemanticManifest } from "../packages/protocol/src/semantic-desktop.ts";

const closers: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (closers.length) await closers.pop()!();
  vi.unstubAllEnvs();
});

async function harness(options: {
  context?: "user" | "desktop"; contract?: "2.5" | "2.6";
  savedProvenance?: boolean; failure?: "native" | "contract" | "session";
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "semantic-sdk-"));
  closers.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("RCMCP_STATE_DIR", root);
  const contract = options.contract ?? "2.6", savedProvenance = options.savedProvenance ?? false;
  const manifest: SemanticManifest = {
    version: 1, engineVersion: contract === "2.6" ? "1.3.0" : "1.0.2", jsonVersion: contract,
    binary: path.join(root, "synthetic-native"), sha256: "a".repeat(64),
    files: [{ path: path.join(root, "synthetic-dependency"), sha256: "b".repeat(64) }],
    ...(savedProvenance ? { upstreamCommit: "c".repeat(40), archiveSha256: "d".repeat(64) } : {}),
    provenanceVerified: savedProvenance,
  };
  const data = { permissions: { accessibility: { state: "granted" }, automation: { state: "not_required" } },
    platform: "linux", ref_count: null, session_id: null, snapshot_id: null,
    supported_surfaces: ["window", "sheet", "alert", "menu"], tracing: false, version: manifest.engineVersion };
  const nativeCalls: string[][] = [], graphicalRequests: boolean[] = [];
  const backend = new SemanticDesktop({ root: path.join(root, "semantic"), manifest: () => manifest,
    session: async (graphical = true) => {
      graphicalRequests.push(graphical);
      if (options.failure === "session") throw new Error("graphical_session_unavailable");
      return { env: {}, fingerprint: "synthetic-session" };
    },
    invoke: async (_ctx, args) => {
      nativeCalls.push(args);
      if (options.failure === "native") return { version: contract, ok: false, command: "status", error: { code: "PERMISSION_DENIED" } };
      return { version: options.failure === "contract" ? "unexpected-contract" : contract, ok: true, command: "status", data };
    },
  });
  const agent = Fastify();
  agent.get("/v1/info", () => ({ runtime: { capabilities: ["desktop-semantic-v1"] } }));
  registerSemanticDesktopRoutes(agent, backend);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => agent.close());
  const agentClient = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1",
    ...(options.context === "desktop" ? { desktopUrl: url } : { userUrl: url }) }]);
  const server = new McpServer({ name: "semantic-production-contract", version: "1" });
  registerTools(server, agentClient);
  const client = new Client({ name: "semantic-sdk-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  closers.push(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(a), client.connect(b)]);
  // The SDK caches and validates the production-advertised output contract.
  const listed = await client.listTools();
  const contractSchema = listed.tools.find(tool => tool.name === "desktop_observe")!.outputSchema as any;
  const identity = { source: "loaded_manifest", binary: manifest.binary, sha256: manifest.sha256,
    engineVersion: manifest.engineVersion, jsonVersion: contract, files: manifest.files,
    upstreamCommit: manifest.upstreamCommit ?? null, archiveSha256: manifest.archiveSha256 ?? null,
    provenance: { source: "saved_manifest", verified: savedProvenance, upstreamRechecked: false } };
  return { backend, nativeCalls, graphicalRequests, data, identity, contractSchema,
    call: () => client.callTool({ name: "desktop_observe", arguments: { device: "fixture", kind: "status" } }) };
}

function structured(result: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>["call"]>>) {
  const value = result.structuredContent as Record<string, any>;
  const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text");
  expect(text).toBeDefined();
  const payload = JSON.parse(text!.text!);
  // Small legacy text omits controller metadata; every semantic field must agree.
  const { operationTrace: _trace, observationCoverage: _coverage, resultRecovery: _recovery, ...semantic } = value;
  expect(payload).toEqual(Object.hasOwn(payload, "resultRecovery") ? value : semantic);
  return value;
}

it.each([
  { context: "user", contract: "2.5", savedProvenance: true },
  { context: "desktop", contract: "2.6", savedProvenance: false },
] as const)("delivers complete $contract engine status through production MCP registration on $context", async options => {
  const f = await harness(options), result = await f.call(), value = structured(result);
  expect(result.isError).not.toBe(true);
  expect(value).toMatchObject({ ok: true, command: "status", version: options.contract,
    engineVersion: f.identity.engineVersion, data: f.data, engineIdentity: f.identity });
  expect(value).not.toHaveProperty("ready"); expect(value).not.toHaveProperty("code");
  const advertised = f.contractSchema.anyOf.find((choice: any) => choice.properties?.engineIdentity).properties.engineIdentity;
  expect(advertised).toMatchObject({ type: "object", additionalProperties: false,
    properties: { source: { const: "loaded_manifest" }, provenance: { additionalProperties: false,
      properties: { source: { const: "saved_manifest" }, upstreamRechecked: { const: false } } } } });
  expect(f.nativeCalls).toEqual([["status"]]); expect(f.graphicalRequests).toEqual([false]);
});

it.each([
  { failure: "native", code: "PERMISSION_DENIED" },
  { failure: "contract", code: "native_contract_mismatch" },
] as const)("preserves failed status $code and loaded identity through the production contract", async ({ failure, code }) => {
  const f = await harness({ failure }), result = await f.call(), value = structured(result);
  expect(result.isError).toBe(true);
  expect(value).toMatchObject({ ok: false, error: { code }, engineIdentity: f.identity });
  expect(value).not.toHaveProperty("ready"); expect(value.code).not.toBe("result_validation_failed");
  expect(f.nativeCalls).toEqual([["status"]]);
});

it("keeps a missing session as a failure without inventing loaded identity or readiness", async () => {
  const f = await harness({ failure: "session" }), result = await f.call(), value = structured(result);
  expect(result.isError).toBe(true);
  expect(value).toMatchObject({ ok: false, error: { code: "graphical_session_unavailable" } });
  expect(value).not.toHaveProperty("engineIdentity"); expect(value).not.toHaveProperty("ready");
  expect(value.code).not.toBe("result_validation_failed"); expect(f.nativeCalls).toEqual([]);
});

it("rejects malformed engine identity through the production output contract without replay", async () => {
  const f = await harness(), observe = f.backend.observe.bind(f.backend);
  vi.spyOn(f.backend, "observe").mockImplementationOnce(async input => {
    const result = await observe(input);
    return { ...result, engineIdentity: { ...result.engineIdentity, sha256: "invalid-digest" } };
  });
  const result = await f.call(), value = structured(result);
  expect(result.isError).toBe(true); expect(value).toMatchObject({ ok: false, code: "result_validation_failed" });
  expect(f.nativeCalls).toEqual([["status"]]);
});
