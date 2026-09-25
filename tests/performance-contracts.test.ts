import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { mapLimit, settledLimit } from "../apps/mcp-server/src/concurrency.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function harness(fake: AgentClient) {
  const server = new McpServer({ name: "test", version: "1" });
  registerHighLevelTools(server, fake);
  const client = new Client({ name: "client", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

describe("bounded scheduling", () => {
  it("mapLimit caps peak concurrency and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const result = await mapLimit(items, 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });
    expect(peak).toBe(4);
    expect(result).toEqual(items.map((item) => item * 2));
  });

  it("settledLimit isolates failures without exceeding the bound", async () => {
    let active = 0;
    let peak = 0;
    const result = await settledLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (item === 3) throw new Error("boom");
      return item;
    });
    expect(peak).toBe(2);
    expect(result[3]).toMatchObject({ index: 3, ok: false, error: "boom" });
    expect(result[5]).toMatchObject({ index: 5, ok: true, result: 5 });
  });

  it("batch_exec honors requested concurrency through the MCP surface", async () => {
    let active = 0;
    let peak = 0;
    const fake = {
      configuredContexts: () => ({ system: true, user: true, desktop: true }),
      exec: async (_device: string, input: { command: string }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { code: 0, signal: null, stdout: input.command, stderr: "", durationMs: 10, timedOut: false, stdoutBytes: input.command.length, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
      },
    } as unknown as AgentClient;
    const client = await harness(fake);
    const items = Array.from({ length: 12 }, (_, i) => ({ device: "pc", command: `item-${i}` }));
    const response = await client.callTool({ name: "batch_exec", arguments: { items, concurrency: 3 } });
    expect(response.isError).not.toBe(true);
    expect(peak).toBe(3);
    const content = response.content as Array<{ type: string; text?: string }>;
    const parsed = JSON.parse(content[0]!.text!);
    expect(parsed.map((item: { result: { stdout: string } }) => item.result.stdout)).toEqual(items.map((item) => item.command));
  });
});
