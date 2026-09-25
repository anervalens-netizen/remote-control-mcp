import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, utimes, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openRawFile, receiveDirectTransfer } from "../apps/agent/src/direct-transfer.ts";
import { fsList, fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { syncDirectory, transferFile } from "../apps/mcp-server/src/transfer-tools.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "rcmcp-direct-")); roots.push(dir); return dir; }
async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => { res.statusCode = 500; res.end(String(error)); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function sourceServer() {
  return listen(async (req, res) => {
    if (req.headers.authorization !== "Bearer source-test") { res.statusCode = 401; res.end(); return; }
    const raw = await openRawFile(new URL(req.url!, "http://local").searchParams.get("path")!);
    res.setHeader("content-length", raw.size);
    res.setHeader("x-rcmcp-modified-at", raw.modifiedAt);
    raw.stream.on("error", () => res.destroy());
    res.on("close", () => raw.stream.destroy());
    raw.stream.pipe(res);
  });
}

it.each([0, 1_048_593])("streams %i binary bytes through authenticated agent routing, preserving timestamp", async (size) => {
  const dir = await root();
  const source = path.join(dir, "source.bin");
  const destination = path.join(dir, "nested", "destination.bin");
  const bytes = randomBytes(size);
  await writeFile(source, bytes);
  const timestamp = new Date("2026-01-02T03:04:05.000Z");
  await utimes(source, timestamp, timestamp);
  const sourceBase = await sourceServer();
  let receiverHits = 0;
  const destinationBase = await listen(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer destination-test");
    expect(req.url).toBe("/v1/fs/transfer-from");
    const parts = [];
    for await (const part of req) parts.push(part);
    receiverHits++;
    const result = await receiveDirectTransfer(JSON.parse(Buffer.concat(parts).toString()));
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
  });
  const client = new AgentClient([
    { name: "source", url: "http://127.0.0.1:1", userUrl: "http://127.0.0.1:2", userDirectUrl: sourceBase, userToken: "source-test" },
    { name: "destination", url: "http://127.0.0.1:3", userUrl: destinationBase, userToken: "destination-test" },
  ]);
  const result = await client.directTransfer("source", "destination", {
    sourcePath: source, destinationPath: destination, expectedBytes: size, expectedModifiedAt: timestamp.toISOString(),
  }, "user", "user");
  expect(receiverHits).toBe(1);
  expect(result).toMatchObject({ ok: true, bytes: size, transport: "direct-agent-binary", modifiedAtPreserved: true });
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(await readFile(destination)).toEqual(bytes);
  expect((await stat(destination)).mtime.toISOString()).toBe(timestamp.toISOString());
  expect(JSON.stringify(result)).not.toContain("source-test");
}, 15_000);

it.each(["truncated", "timeout", "changed", "unauthorized"])("preserves the destination and removes staging on %s", async (mode) => {
  const dir = await root();
  const destination = path.join(dir, "destination");
  await writeFile(destination, "original");
  const base = await listen((_req, res) => {
    if (mode === "unauthorized") { res.statusCode = 401; res.end("secret must not appear"); return; }
    res.setHeader("content-length", "100");
    res.flushHeaders();
    if (mode === "timeout") { res.write("x"); return; }
    if (mode === "changed") { res.end("x".repeat(100)); return; }
    res.write("short"); setTimeout(() => res.destroy(), 20);
  });
  // Error-classification fixtures allow native Windows ACL startup; the deadline fixture remains80ms.
  await expect(receiveDirectTransfer({
    sourceBase: base, sourcePath: "test", destinationPath: destination,
    timeoutMs: mode === "timeout" ? 80 : 10_000, ...(mode === "changed" ? { expectedBytes: 101 } : {}),
  })).rejects.toThrow(mode === "timeout" ? /timed out/ : mode === "unauthorized" ? /HTTP 401$/ : mode === "changed" ? /changed/ : /./);
  expect(await readFile(destination, "utf8")).toBe("original");
  expect(await readdir(dir)).toEqual(["destination"]);
});

it("does not follow redirects or pass source credentials to another endpoint", async () => {
  const dir = await root(); let targetHits = 0;
  const target = await listen((_req, res) => { targetHits++; res.end("unexpected"); });
  const redirect = await listen((_req, res) => { res.writeHead(307, { location: target }); res.end(); });
  await expect(receiveDirectTransfer({ sourceBase: redirect, sourceToken: "source-test", sourcePath: "file", destinationPath: path.join(dir, "out") })).rejects.toThrow();
  expect(targetHits).toBe(0);
  expect(await readdir(dir)).toEqual([]);
});

it("rejects a source timestamp change and missing binary length before activation", async () => {
  const dir = await root();
  const base = await listen((_req, res) => { res.setHeader("content-length", 1); res.setHeader("x-rcmcp-modified-at", "2026-01-01T00:00:00.000Z"); res.end("x"); });
  await expect(receiveDirectTransfer({ sourceBase: base, sourcePath: "file", destinationPath: path.join(dir, "out"), expectedModifiedAt: "2026-01-02T00:00:00.000Z" })).rejects.toThrow(/timestamp changed/);
  const unknownLength = await listen((_req, res) => { res.write("x"); res.end(); });
  await expect(receiveDirectTransfer({ sourceBase: unknownLength, sourcePath: "file", destinationPath: path.join(dir, "out") })).rejects.toThrow(/content-length/);
});

function localClient() {
  return {
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
    fsManage: async (_device: string, input: Parameters<typeof fsManage>[0]) => fsManage(input),
    fsList: async (_device: string, input: Parameters<typeof fsList>[0]) => fsList(input),
    fsRead: async (_device: string, input: Parameters<typeof fsRead>[0]) => fsRead(input),
    fsWrite: async (_device: string, input: Parameters<typeof fsWrite>[0]) => fsWrite(input),
  } as unknown as AgentClient;
}
it("incremental sync copies changes only, preserves destination-only files and supports forced copy", async () => {
  const dir = await root(), source = path.join(dir, "source"), destination = path.join(dir, "destination");
  await mkdir(path.join(source, "nested"), { recursive: true });
  await mkdir(destination);
  await writeFile(path.join(source, "a"), "aaa");
  await writeFile(path.join(source, "nested", "b"), "bbb");
  await writeFile(path.join(destination, "retained"), "keep");
  const input = { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, compare: "size-mtime" as const };
  const first = await syncDirectory(localClient(), input);
  expect(first).toMatchObject({ filesTransferred: 2, filesUnchanged: 0, bytes: 6 });
  const second = await syncDirectory(localClient(), input);
  expect(second).toMatchObject({ filesTransferred: 0, filesUnchanged: 2, bytes: 0 });
  const changed = path.join(source, "nested", "b");
  await writeFile(changed, "ccc");
  const later = new Date(Date.now() + 3000); await utimes(changed, later, later);
  const third = await syncDirectory(localClient(), input);
  expect(third).toMatchObject({ filesTransferred: 1, filesUnchanged: 1, bytes: 3 });
  expect(await readFile(path.join(destination, "nested", "b"), "utf8")).toBe("ccc");
  expect(await readFile(path.join(destination, "retained"), "utf8")).toBe("keep");
  expect(await syncDirectory(localClient(), { ...input, compare: "always" })).toMatchObject({ filesTransferred: 2, filesUnchanged: 0 });
});

it("retains old data when the source mutates during a relayed transfer", async () => {
  const dir = await root(), source = path.join(dir, "source"), destination = path.join(dir, "destination");
  await writeFile(source, "abc"); await writeFile(destination, "old");
  const client = localClient(), read = client.fsRead.bind(client);
  client.fsRead = async (...args) => {
    const result = await read(...args);
    await writeFile(source, "changed");
    return result;
  };
  await expect(transferFile(client, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination })).rejects.toThrow(/Source changed/);
  expect(await readFile(destination, "utf8")).toBe("old");
});

it("keeps same-file protection before direct transfer and preserves explicit source context", async () => {
  const dir = await root(), source = path.join(dir, "source");
  await writeFile(source, "abc");
  const client = localClient();
  client.directTransfer = async () => { throw new Error("must not run"); };
  expect(await transferFile(client, { sourceDevice: "pc", sourcePath: source, destinationDevice: "pc", destinationPath: source, transport: "direct" })).toMatchObject({ sameFile: true });
  const configured = new AgentClient([{ name: "a", url: "http://127.0.0.1:1" }]);
  expect(() => configured.directTransfer("a", "a", { sourcePath: source, destinationPath: source }, "user", "system")).toThrow(/user context is not configured/);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("updates and syncs owner-read-only timestamps without requiring content write access", async () => {
  const dir = await root(), target = path.join(dir, "readonly");
  await writeFile(target, "unchanged");
  await chmod(target, 0o444);
  try {
    const modifiedAt = "2026-01-02T03:04:05.000Z";
    const result = await fsManage({ operation: "times", path: target, modifiedAt });
    expect(result).toMatchObject({ ok: true, modifiedAt, metadataSynced: true, durable: true });
    expect(await readFile(target, "utf8")).toBe("unchanged");
    expect((await stat(target)).mode & 0o777).toBe(0o444);
  } finally { await chmod(target, 0o600); }
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports metadata durability limitations without failing after a successful timestamp update", async () => {
  const dir = await root(), target = path.join(dir, "no-content-access");
  await writeFile(target, "unchanged"); await chmod(target, 0o000);
  try {
    const modifiedAt = "2026-01-02T03:04:05.000Z";
    const result = await fsManage({ operation: "times", path: target, modifiedAt });
    expect(result).toMatchObject({ ok: true, modifiedAt, metadataSynced: false, durable: false });
    expect(result).toHaveProperty("durabilityError");
    expect((await stat(target)).mode & 0o777).toBe(0);
  } finally { await chmod(target, 0o600); }
});
