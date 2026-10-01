import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { fsReadFields, fsReadResultSchema } from "../packages/protocol/src/execution.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { appendFile, link, stat, readdir, mkdtemp, readFile, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";
import { transferFile, syncDirectory } from "../apps/mcp-server/src/transfer-tools.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const oldBytes = Buffer.concat([Buffer.alloc(65536, "A"), Buffer.alloc(65536, "1")]);
const newBytes = Buffer.concat([Buffer.alloc(65536, "B"), Buffer.alloc(65536, "2")]);
const mtime = new Date("2020-01-01T00:00:00.000Z");
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-a11-")); roots.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  await writeFile(source, oldBytes, { mode: 0o600 }); await utimes(source, mtime, mtime);
  await writeFile(destination, "existing destination", { mode: 0o640 });
  return { root, source, destination };
}
function client(afterRead?: () => Promise<void>) {
  let reads = 0;
  return {
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1, relaySourceVersion: 1 } }),
    fsManage: async (_device: string, input: Parameters<typeof fsManage>[0]) => fsManage(input),
    fsRead: async (_device: string, input: Parameters<typeof fsRead>[0]) => {
      const result = await fsRead(z.object(fsReadFields).parse(input));
      if (result.bytesRead > 0 && ++reads === 1) await afterRead?.();
      return result;
    },
    fsWrite: async (_device: string, input: Parameters<typeof fsWrite>[0]) => fsWrite(input),
  };
}
function input(source: string, destination: string) {
  return { sourceDevice: "source", sourcePath: source, destinationDevice: "destination", destinationPath: destination, chunkBytes: 65536, preserveTimestamps: true };
}
it.each(["replacement", "rewrite", "append", "truncate", "mtime"])("rejects %s after first 64 KiB read and preserves destination", async mutation => {
  const { root, source, destination } = await fixture();
  const replacement = path.join(root, "replacement");
  await writeFile(replacement, newBytes, { mode: 0o600 }); await utimes(replacement, mtime, mtime);
  const transport = client(async () => {
    if (mutation === "replacement") await rename(replacement, source);
    if (mutation === "rewrite") { await writeFile(source, newBytes); await utimes(source, mtime, mtime); }
    if (mutation === "append") await appendFile(source, "extra");
    if (mutation === "truncate") await truncate(source, 65536);
    if (mutation === "mtime") await utimes(source, mtime, new Date("2021-01-01T00:00:00.000Z"));
  });
  await expect(transferFile(transport as unknown as AgentClient, input(source, destination))).rejects.toThrow(/Source changed|Unexpected EOF/);
  expect(await readFile(destination, "utf8")).toBe("existing destination");
  expect((await readdir(root)).some(name => name.startsWith(".rcmcp-transfer-"))).toBe(false);
});
it("copies a stable source across two 64 KiB chunks", async () => {
  const { source, destination } = await fixture();
  const result = await transferFile(client() as unknown as AgentClient, input(source, destination));
  expect(result).toMatchObject({ bytes: 131072, chunks: 2, atomic: true, sourceStableVerified: true, sourceVerification: "generation-bound-reads-and-final-confirmation" });
  expect(await readFile(destination)).toEqual(oldBytes);
  expect((await stat(destination)).mtime.toISOString()).toBe(mtime.toISOString());
  if (process.platform !== "win32") expect((await stat(destination)).mode & 0o777).toBe(0o640);
});
it.each([false, true])("rejects an old source without mutation (allowLegacyAgent=%s)", async allowLegacyAgent => {
  const { source, destination } = await fixture();
  const base = client(); let mutations = 0;
  const old = { ...base,
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
    fsManage: async (device: string, request: Parameters<typeof fsManage>[0]) => {
      if (device === "destination" && request.operation !== "stat") mutations++;
      return base.fsManage(device, request);
    },
  };
  await expect(transferFile(old as unknown as AgentClient, { ...input(source, destination), allowLegacyAgent })).rejects.toThrow(/generation-bound relay reads/);
  expect(mutations).toBe(0);
  expect(await readFile(destination, "utf8")).toBe("existing destination");
});
it("checks source generation after destination timestamp work and before publication", async () => {
  const { source, destination } = await fixture();
  const base = client();
  const transport = { ...base, fsManage: async (device: string, request: Parameters<typeof fsManage>[0]) => {
    const result = await base.fsManage(device, request);
    if (request.operation === "times") { await writeFile(source, newBytes); await utimes(source, mtime, mtime); }
    return result;
  } };
  await expect(transferFile(transport as unknown as AgentClient, input(source, destination))).rejects.toThrow(/Source changed/);
  expect(await readFile(destination, "utf8")).toBe("existing destination");
});
it("verifies empty files before publication", async () => {
  const { source, destination } = await fixture(); await truncate(source, 0);
  const base = client();
  const transport = { ...base, fsWrite: async (device: string, request: Parameters<typeof fsWrite>[0]) => {
    const result = await base.fsWrite(device, request); await appendFile(source, "new"); return result;
  } };
  await expect(transferFile(transport as unknown as AgentClient, input(source, destination))).rejects.toThrow(/Source changed/);
  expect(await readFile(destination, "utf8")).toBe("existing destination");
  await truncate(source, 0);
  await expect(transferFile(base as unknown as AgentClient, input(source, destination))).resolves.toMatchObject({ bytes: 0, chunks: 0 });
  expect(await readFile(destination, "utf8")).toBe("");
});
it("keeps same-file and hardlink no-ops available with an older source", async () => {
  const { source, destination } = await fixture();
  await rm(destination); await link(source, destination);
  const old = { ...client(), info: async () => ({ platform: process.platform }) };
  for (const destinationPath of [source, destination]) {
    await expect(transferFile(old as unknown as AgentClient, { ...input(source, destinationPath), destinationDevice: "source" })).resolves.toMatchObject({ sameFile: true, chunks: 0 });
  }
  expect(await readFile(source)).toEqual(oldBytes);
});
it("rejects missing version receipts despite a capability claim", async () => {
  const { source, destination } = await fixture(); const base = client();
  const transport = { ...base, fsRead: async (device: string, request: Parameters<typeof fsRead>[0]) => {
    const result = { ...await base.fsRead(device, request) } as Record<string, unknown>; delete result.sourceVersion; return result;
  } };
  await expect(transferFile(transport as unknown as AgentClient, input(source, destination))).rejects.toThrow(/versioned read receipt/);
  expect(await readFile(destination, "utf8")).toBe("existing destination");
});
it("advertises and enforces versioned reads through the MCP SDK contract", async () => {
  const { source, destination } = await fixture();
  const base = client();
  const transport = { ...base, resolveContext: () => "system", devices: [], configuredContexts: () => ({ system: true, user: false, desktop: false }) };
  const server = new McpServer({ name: "synthetic-relay", version: "1" });
  registerTools(server, transport as unknown as AgentClient);
  const sdk = new Client({ name: "synthetic-client", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), sdk.connect(ct)]);
    const listing = await sdk.listTools();
    const readTool = listing.tools.find(tool => tool.name === "fs_read")!;
    expect(readTool.inputSchema.properties).toHaveProperty("versioned");
    expect(readTool.inputSchema.properties).toHaveProperty("expectedVersion");
    expect(JSON.stringify(readTool.outputSchema)).toContain("sourceVersion");
    const initial = await sdk.callTool({ name: "fs_read", arguments: { device: "source", path: source, versioned: true, length: 0 } });
    expect(initial.isError).not.toBe(true);
    const receipt = fsReadResultSchema.parse(initial.structuredContent);
    const metadata = await stat(source, { bigint: true });
    expect(receipt.sourceVersion).toBe([metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":"));
    await writeFile(source, newBytes); await utimes(source, mtime, mtime);
    const changed = await sdk.callTool({ name: "fs_read", arguments: { device: "source", path: source, length: 65536, expectedVersion: receipt.sourceVersion } });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed)).toContain("Source changed");
    const copied = await sdk.callTool({ name: "file_transfer", arguments: input(source, destination) });
    expect(copied.isError).not.toBe(true);
    expect(await readFile(destination)).toEqual(newBytes);
  } finally { await sdk.close(); await server.close(); }
});
it("rejects an old directory source before creating any destination directories", async () => {
  const { root, source } = await fixture(); const destination = path.join(root, "new-tree");
  const base = client(); let mutations = 0;
  const transport = { ...base,
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
    fsList: async () => [{ name: "source", path: source, type: "file", size: oldBytes.length }],
    fsManage: async (device: string, request: Parameters<typeof fsManage>[0]) => {
      if (device === "destination" && request.operation !== "stat") mutations++;
      return base.fsManage(device, request);
    },
  };
  await expect(syncDirectory(transport as unknown as AgentClient, { ...input(root, destination), allowLegacyAgent: true })).rejects.toThrow(/generation-bound relay reads/);
  expect(mutations).toBe(0);
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});
it("enforces expectedVersion even with versioned=false and keeps ordinary reads available", async () => {
  const { source } = await fixture();
  const initial = fsReadResultSchema.parse(await fsRead({ path: source, versioned: true, length: 0 }));
  await writeFile(source, newBytes); await utimes(source, mtime, mtime);
  // Keep a failing receipt small enough to retain both versions in CI output.
  // Equal metadata after an equal-size rewrite is a source-qualification gap,
  // not permission to skip the rejection assertion or change the fixture size.
  const checkedRead = fsRead({ path: source, versioned: false, expectedVersion: initial.sourceVersion, length: 65536 })
    .then(({ sourceVersion }) => ({ sourceVersion }));
  await expect(checkedRead, `reserved sourceVersion=${initial.sourceVersion}`).rejects.toThrow(/Source changed/);
  expect((await fsRead({ path: source, length: 65536 })).data).toBe("B".repeat(65536));
  await expect(fsRead({ path: source, versioned: true, tailBytes: 1 })).rejects.toThrow(/byte paging/);
  expect(z.object(fsReadFields).safeParse({ path: source, expectedVersion: "invalid" }).success).toBe(false);
});

it("reports authoritative empty-file size and EOF for versioned zero-byte reads", async () => {
  const { source } = await fixture(); await truncate(source, 0);
  for (const offset of [0, 10]) {
    const result = await fsRead({ path: source, versioned: true, offset, length: 0, encoding: "base64" });
    expect(result).toMatchObject({ totalBytes: 0, bytesRead: 0, eof: true, nextOffset: offset });
    expect(fsReadResultSchema.parse(result).sourceVersion).toMatch(/^\d+:\d+:0:/);
  }
});
