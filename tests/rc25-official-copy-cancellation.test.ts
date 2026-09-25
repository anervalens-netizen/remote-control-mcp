import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.doUnmock("node:fs/promises"); vi.doUnmock("../apps/agent/src/filesystem.ts"); vi.resetModules();
});
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc25-official-copy-"));
  closers.push(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  await fs.mkdir(source); await fs.mkdir(destination);
  await fs.writeFile(path.join(source, "a"), "copied bytes");
  await fs.writeFile(path.join(source, "b"), "must not overwrite");
  await fs.writeFile(path.join(destination, "b"), "original bytes");
  const written = barrier<void>(), release = barrier<void>(), aborted = barrier<void>();
  const finished = barrier<unknown>();
  let routeSignal: AbortSignal | undefined;
  const copies: string[] = [];
  vi.doMock("node:fs/promises", () => ({ ...fs,
    // Complete the real read/write of a tiny first file, then hold its return.
    // Cancellation must reach the production route before traversal resumes.
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      copies.push(String(args[0]));
      await fs.copyFile(...args);
      if (String(args[0]) === path.join(source, "a")) { written.resolve(); await release.promise; }
    },
  }));
  vi.doMock("../apps/agent/src/filesystem.ts", async original => {
    const actual = await original<typeof import("../apps/agent/src/filesystem.ts")>();
    return { ...actual, fsManage: async (input: Parameters<typeof actual.fsManage>[0], signal?: AbortSignal) => {
      routeSignal = signal;
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      const receipt = await actual.fsManage(input, signal); finished.resolve(receipt); return receipt;
    } };
  });
  const agent = Fastify();
  (await import("../apps/agent/src/filesystem-routes.ts")).registerFilesystemManageRoute(agent);
  const url = await agent.listen({ host: "127.0.0.1", port: 0 });
  closers.push(() => agent.close());
  const client = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1", userUrl: url }]);
  const manage = vi.spyOn(client, "fsManage");
  const server = new McpServer({ name: "official-copy", version: "1" }); registerTools(server, client);
  const sdk = new Client({ name: "official-copy-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), sdk.connect(right)]);
  closers.push(async () => { await sdk.close(); await server.close(); });
  return { source, destination, written, release, aborted, finished, copies, manage, client, sdk, signal: () => routeSignal };
}

it("forwards SDK cancellation through HTTP to the real copy route, preserving partial bytes and preventing later overwrite", async () => {
  const f = await fixture(), controller = new AbortController();
  const pending = f.sdk.callTool({ name: "fs_manage", arguments: {
    device: "fixture", identity: "owner", operation: "copy", path: f.source, destination: f.destination, force: true,
  } }, undefined, { signal: controller.signal });
  void pending.catch(() => undefined);
  try {
    await f.written.promise;
    expect(await fs.readFile(path.join(f.destination, "a"), "utf8")).toBe("copied bytes");
    expect(f.manage.mock.calls[0]?.[2]).toBe("user");
    expect(f.manage.mock.calls[0]?.[3]?.signal).toBeInstanceOf(AbortSignal);
    controller.abort(new Error("explicit SDK copy cancellation"));
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.signal()?.aborted).toBe(true));
    await f.aborted.promise;
    expect(f.manage.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    f.release.resolve();
    expect(await f.finished.promise).toMatchObject({ copied: 1, cancelled: true, timedOut: false, outcome: "partial", partialEffectsPossible: true });
    expect(await fs.readFile(path.join(f.destination, "a"), "utf8")).toBe("copied bytes");
    expect(await fs.readFile(path.join(f.destination, "b"), "utf8")).toBe("original bytes");
    expect(f.copies).toEqual([path.join(f.source, "a")]);
    expect(f.manage).toHaveBeenCalledTimes(1);
  } finally { controller.abort(); f.release.resolve(); await f.finished.promise; await pending.catch(() => undefined); }
});

it("pre-aborted SDK calls cause no copy mutations or HTTP dispatch", async () => {
  const f = await fixture();
  f.release.resolve();
  await expect(f.sdk.callTool({ name: "fs_manage", arguments: {
    device: "fixture", identity: "owner", operation: "copy", path: f.source, destination: f.destination,
  } }, undefined, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(f.manage).not.toHaveBeenCalled(); expect(f.copies).toEqual([]);
  expect(existsSync(path.join(f.destination, "a"))).toBe(false);
  expect(await fs.readFile(path.join(f.destination, "b"), "utf8")).toBe("original bytes");
});

it("retains production route deadline classification at the same write barrier", async () => {
  const f = await fixture();
  const pending = f.client.fsManage("fixture", {
    operation: "copy", path: f.source, destination: f.destination, timeoutMs: 1000,
  }, "user");
  try {
    await f.written.promise;
    await f.aborted.promise;
    f.release.resolve();
    expect(await pending).toMatchObject({ copied: 1, cancelled: true, timedOut: true, partialEffectsPossible: true });
    expect(await fs.readFile(path.join(f.destination, "b"), "utf8")).toBe("original bytes");
  } finally { f.release.resolve(); await pending; }
});
