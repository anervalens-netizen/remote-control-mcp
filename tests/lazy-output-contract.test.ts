import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { withErrorOutputContract } from "../apps/mcp-server/src/error-output-contract.ts";

const { AjvJsonSchemaValidator } = createRequire(import.meta.url)("@modelcontextprotocol/sdk/validation/ajv") as {
  AjvJsonSchemaValidator: { prototype: jsonSchemaValidator };
};
afterEach(() => vi.restoreAllMocks());

it("compiles once on the first result and rejects JSON-only mismatches immediately", () => {
  const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
  const success = z.object({ count: z.number().int() });
  const contract = withErrorOutputContract(success);
  const advertised = z.toJSONSchema(contract);
  expect(compile).not.toHaveBeenCalled();

  // Zod strips this property; the advertised JSON Schema forbids it. Make this
  // the first result so a lazy validator cannot accidentally admit it untested.
  const mismatch = { count: 1, undeclared: "synthetic evidence" };
  expect(success.safeParse(mismatch).success).toBe(true);
  expect(contract.safeParse(mismatch).success).toBe(false);
  expect(compile).toHaveBeenCalledTimes(1);
  // The passthrough Zod object adds only these permissive root fields; the
  // success/error/omission alternatives must be exactly those compiled by AJV.
  expect({ ...compile.mock.calls[0]![0], type: "object", properties: {}, additionalProperties: {} }).toEqual(advertised);
  expect(contract.safeParse({ count: 1 }).success).toBe(true);
  expect(contract.safeParse({}).success).toBe(false);
  expect(contract.safeParse({ ok: false, error: "synthetic failure" }).success).toBe(true);
  expect(withErrorOutputContract(success)).toBe(contract);
  expect(withErrorOutputContract(success).safeParse(mismatch).success).toBe(false);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(z.toJSONSchema(contract)).toEqual(advertised);

  const other = withErrorOutputContract(z.object({ label: z.string() }));
  expect(compile).toHaveBeenCalledTimes(1);
  expect(other.safeParse({ count: 1 }).success).toBe(false);
  expect(other.safeParse({ label: "fixture" }).success).toBe(true);
  expect(compile).toHaveBeenCalledTimes(2);
});

it("keeps repeated cold/warm registration and tools/list free of AJV compilation", async () => {
  const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator");
  const cold: number[] = [], warm: number[] = [];
  for (let sample = 0; sample < 3; sample++) {
    // Reset the contract WeakMap and schema modules, outside the measured path.
    vi.resetModules();
    const { registerTools } = await import("../apps/mcp-server/src/all-tools.ts");
    const { AgentClient } = await import("../apps/mcp-server/src/agent-client.ts");
    for (const durations of [cold, warm]) {
      const server = new McpServer({ name: "registry-fixture", version: "1" });
      const client = new Client({ name: "catalog-fixture", version: "1" });
      try {
        const started = performance.now();
        registerTools(server, new AgentClient([]));
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(a), client.connect(b)]);
        // Exercise the actual tools/list handler without Client.listTools's
        // independent, eager client-side output validator cache.
        const catalog = await client.request({ method: "tools/list" }, ListToolsResultSchema);
        durations.push(performance.now() - started);
        expect(catalog.tools).toHaveLength(93);
        expect(catalog.tools.every(tool => tool.outputSchema?.type === "object")).toBe(true);
        // Deterministic guard even when host load makes timing inconclusive.
        expect(compile).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[1]!;
  // Medians suppress one-off scheduling/GC noise; allow substantial cold-cache
  // overhead and a generous two-second floor on shared/slow test hosts.
  expect(median(cold)).toBeLessThan(Math.max(2_000, median(warm) * 6));
  console.info("Registry construction + tools/list (ms)", { cold, warm });
}, 30_000);
