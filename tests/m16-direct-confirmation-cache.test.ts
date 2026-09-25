import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const counter = vi.hoisted(() => ({ hashes: 0 }));
vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, createHash: new Proxy(original.createHash, { apply(target, receiver, args) { counter.hashes++; return Reflect.apply(target, receiver, args); } }) };
});
import { openRawFile } from "../apps/agent/src/direct-transfer.ts";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function source() { const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-head-cache-")); roots.push(root); const file = path.join(root, "source"); await writeFile(file, "initial"); counter.hashes = 0; return file; }
async function drain(stream: NodeJS.ReadableStream) { const parts: Buffer[] = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); }
it("avoids a third full source read during unchanged final HEAD confirmation", async () => {
  const file = await source(); const raw = await openRawFile(file);
  expect(await drain(raw.stream)).toEqual(await readFile(file)); expect(counter.hashes).toBe(1);
  const head = await openRawFile(file, { metadataOnly: true }); head.stream.destroy();
  expect(head.sha256).toBe(raw.sha256); expect(counter.hashes).toBe(1);
});
it("invalidates the cached digest on an in-place change even when size and mtime are restored", async () => {
  const file = await source(); const originalStat = await stat(file); const raw = await openRawFile(file); await drain(raw.stream);
  await new Promise(resolve => setTimeout(resolve, 25)); await writeFile(file, "changed"); await utimes(file, originalStat.atime, originalStat.mtime);
  const head = await openRawFile(file, { metadataOnly: true }); head.stream.destroy();
  expect(head.sha256).not.toBe(raw.sha256); expect(counter.hashes).toBe(2);
});
it("expires metadata cache entries rather than keeping an unbounded lifetime", async () => {
  const file = await source(); const raw = await openRawFile(file); await drain(raw.stream);
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 3 * 60 * 60 * 1000);
  const head = await openRawFile(file, { metadataOnly: true }); head.stream.destroy();
  expect(head.sha256).toBe(raw.sha256); expect(counter.hashes).toBe(2);
});
it("honors cancellation before reusing a cached final confirmation", async () => {
  const file = await source(); const raw = await openRawFile(file); await drain(raw.stream);
  await expect(openRawFile(file, { metadataOnly: true, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(counter.hashes).toBe(1);
});

it.each([1700000000.1231, 1700000000.1239])("keeps the public filesystem timestamp representation for fractional mtime %s", async seconds => {
  const file = await source(); await utimes(file, seconds, seconds);
  const expected = (await stat(file)).mtime.toISOString();
  const raw = await openRawFile(file); await drain(raw.stream);
  const head = await openRawFile(file, { metadataOnly: true }); head.stream.destroy();
  expect(raw.modifiedAt).toBe(expected); expect(head.modifiedAt).toBe(expected);
});
