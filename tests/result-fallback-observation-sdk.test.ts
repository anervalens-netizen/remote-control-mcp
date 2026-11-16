import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerConsoleTools } from "../apps/mcp-server/src/console-tools.ts";
import { recoveryFor } from "../apps/mcp-server/src/result-recovery.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); while (closers.length) await closers.pop()!(); vi.unstubAllEnvs(); });

it.each(["validation", "delivery"] as const)("preserves trace and coverage on a %s fallback without replaying the original handler", async failure => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fallback-sdk-"));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  vi.stubEnv("RCMCP_STATE_DIR", directory);
  const agent = new AgentClient([]);
  const server = new McpServer({ name: "fallback-observation", version: "1" });
  installDefaultToolOutputContracts(server, undefined, agent);
  registerConsoleTools(server, agent);
  let invocations = 0;
  const originalPayload = { count: failure === "validation" ? "synthetic-invalid-count" : 1 };
  server.registerTool("fixture_fallback", { inputSchema: { note: z.string() }, outputSchema: { count: z.number() } }, async () => {
    invocations++;
    return { content: [{ type: "text" as const, text: JSON.stringify(originalPayload) }], structuredContent: originalPayload };
  });
  if (failure === "delivery") {
    const store = recoveryFor(agent), finish = store.finish.bind(store);
    vi.spyOn(store, "finish").mockImplementationOnce((id, value) => {
      finish(id, value);
      throw new Error("Synthetic failure after original receipt publication");
    });
  }
  const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  await client.listTools();
  const result = await client.callTool({ name: "fixture_fallback", arguments: { note: "private-argument-not-in-journal" } });
  expect(result.isError).toBe(true);
  const delivered = result.structuredContent as any;
  expect(delivered).toMatchObject({ ok: false, code: failure === "validation" ? "result_validation_failed" : "result_delivery_failed",
    operationTrace: { traceId: expect.any(String), controllerInstanceId: expect.any(String) },
    observationCoverage: { admitted: true, observationPersistence: "confirmed" }, resultRecovery: { noReplay: true } });
  const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === "text");
  expect(text?.type).toBe("text");
  expect(JSON.parse((text as { text: string }).text)).toEqual(delivered);
  const inspected = await client.callTool({ name: "operation_inspect", arguments: { reference: { traceId: delivered.operationTrace.traceId } } });
  expect(inspected.isError).not.toBe(true);
  const observation = (inspected.structuredContent as any).observation;
  expect(observation).toMatchObject({ traceId: delivered.operationTrace.traceId,
    controllerInstanceId: delivered.operationTrace.controllerInstanceId, tool: "fixture_fallback" });
  expect(JSON.stringify(observation)).not.toContain("private-argument-not-in-journal");
  const recovered = await client.callTool({ name: "result_recover", arguments: { id: delivered.resultRecovery.id } });
  expect(recovered.isError).not.toBe(true);
  const page = recovered.structuredContent as any;
  expect(page.eof).toBe(true);
  const original = JSON.parse(Buffer.from(page.data, "base64").toString("utf8"));
  expect(original.structuredContent).toMatchObject({ ...originalPayload, operationTrace: delivered.operationTrace,
    observationCoverage: { admitted: true } });
  expect(original.isError).not.toBe(true);
  expect(invocations).toBe(1);
});
