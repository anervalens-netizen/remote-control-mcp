import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fsRead } from "../apps/agent/src/filesystem.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

it("preserves fs_read cross-field validation before dispatch through the modern HTTP SDK", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fs-read-modern-"));
  const file = path.join(root, "source.txt");
  await writeFile(file, "alpha\nbeta\n");
  const backend = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  const reads = vi.spyOn(backend, "fsRead").mockImplementation(async (_device, input) =>
    fsRead(input as Parameters<typeof fsRead>[0]));
  const http = createMcpHttpServer(backend, { token: "fixture-modern-contract" });
  const client = new Client({ name: "fixture-modern-client", version: "1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: "Bearer fixture-modern-contract" } },
    }));
    const catalog = await client.listTools();
    expect(catalog.tools.some(tool => tool.name === "fs_read")).toBe(true);
    expect(catalog.tools.some(tool => tool.name === "batch_read")).toBe(true);

    // These fields are individually valid JSON Schema values. Rejection must
    // retain the original Zod cross-field refinement across the SDK boundary.
    const invalid = await client.callTool({ name: "fs_read", arguments: {
      device: "fixture", path: file, versioned: true, maxBytes: 4,
    } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain("Input validation error");
    expect(JSON.stringify(invalid.content)).toContain("byte paging");
    expect(reads).toHaveBeenCalledTimes(0);

    // A valid first item must not execute before a later item's refinement fails.
    const invalidBatch = await client.callTool({ name: "batch_read", arguments: { items: [
      { device: "fixture", path: file, offset: 0, length: 4 },
      { device: "fixture", path: file, versioned: true, maxBytes: 4 },
    ] } });
    expect(invalidBatch.isError).toBe(true);
    expect(JSON.stringify(invalidBatch.content)).toContain("Input validation error");
    expect(JSON.stringify(invalidBatch.content)).toContain("byte paging");
    expect(reads).toHaveBeenCalledTimes(0);

    const valid = await client.callTool({ name: "fs_read", arguments: {
      device: "fixture", path: file, offset: 0, length: 4, versioned: true,
    } });
    expect(valid.isError).not.toBe(true);
    expect(valid.structuredContent).toMatchObject({
      data: "alph", nextOffset: 4, eof: false, sourceVersion: expect.any(String),
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]![1]).toMatchObject({ path: file, offset: 0, length: 4, versioned: true });
    expect(reads.mock.calls[0]![1]).not.toHaveProperty("maxBytes");
  } finally {
    await client.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    reads.mockRestore();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);
