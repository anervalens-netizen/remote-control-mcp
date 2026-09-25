import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";
import { syncDirectory, transferFile } from "../apps/mcp-server/src/transfer-tools.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function localClient(failWriteAt?: number) {
  let writes = 0;
  return {
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
    fsManage: async (_device: string, input: Parameters<typeof fsManage>[0]) => fsManage(input),
    fsRead: async (_device: string, input: Parameters<typeof fsRead>[0]) => fsRead(input),
    fsWrite: async (_device: string, input: Parameters<typeof fsWrite>[0]) => {
      writes += 1;
      if (failWriteAt !== undefined && writes === failWriteAt) throw new Error("simulated connection lost");
      return fsWrite(input);
    },
  };
}

describe("atomic file transfer", () => {
  it("treats the same file and hardlink aliases as no-op without truncation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin");
    const alias = path.join(root, "alias.bin");
    const original = Buffer.alloc(98_304, 0x5a);
    await writeFile(source, original);

    const direct = await transferFile(localClient() as any, { sourceDevice: "pc", sourcePath: source, destinationDevice: "pc", destinationPath: source, chunkBytes: 65_536 });
    expect(direct.sameFile).toBe(true);
    expect(await readFile(source)).toEqual(original);

    if (process.platform !== "win32") {
      await link(source, alias);
      const linked = await transferFile(localClient() as any, { sourceDevice: "pc", sourcePath: source, destinationDevice: "pc", destinationPath: alias, chunkBytes: 65_536 });
      expect(linked.sameFile).toBe(true);
      expect(await readFile(source)).toEqual(original);
    }
  });

  it("queries the destination identity when equal path strings use different execution contexts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-context-")); roots.push(root);
    const source = path.join(root, "same-name.bin");
    await writeFile(source, "context-aware");
    const base = localClient() as any;
    const seen: Array<{ operation: string; context?: string }> = [];
    const client = {
      ...base,
      fsManage: async (device: string, input: Parameters<typeof fsManage>[0], context?: string) => {
        seen.push({ operation: input.operation, context });
        return base.fsManage(device, input, context);
      },
    };
    const result = await transferFile(client as any, {
      sourceDevice: "pc", sourcePath: source, sourceContext: "system",
      destinationDevice: "pc", destinationPath: source, destinationContext: "user",
    });
    expect(result.sameFile).toBe(true);
    expect(seen).toContainEqual({ operation: "stat", context: "system" });
    expect(seen).toContainEqual({ operation: "stat", context: "user" });
  });

  it("preserves the old destination if a transfer is interrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin"); const destination = path.join(root, "destination.bin");
    await writeFile(source, Buffer.alloc(3 * 65_536, 0x61));
    const old = Buffer.from("OLD-VALID-DATA"); await writeFile(destination, old);
    await expect(transferFile(localClient(2) as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, chunkBytes: 65_536 })).rejects.toThrow("simulated connection lost");
    expect(await readFile(destination)).toEqual(old);
  });

  it("cancels relay transfer before activation and preserves the old destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-cancel-")); roots.push(root);
    const source = path.join(root, "source.bin"); const destination = path.join(root, "destination.bin");
    await writeFile(source, Buffer.alloc(3 * 65_536, 0x63));
    const old = Buffer.from("OLD-CANCEL-SAFE-DATA"); await writeFile(destination, old);
    const controller = new AbortController();
    const base = localClient() as any;
    let writes = 0;
    let moves = 0;
    const client = {
      ...base,
      fsWrite: async (device: string, input: Parameters<typeof fsWrite>[0]) => {
        const result = await base.fsWrite(device, input);
        writes += 1;
        if (writes === 1) controller.abort();
        return result;
      },
      fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
        if (input.operation === "transfer-finalize") moves += 1;
        return base.fsManage(device, input);
      },
    };
    await expect(transferFile(client as any, {
      sourceDevice: "a", sourcePath: source,
      destinationDevice: "b", destinationPath: destination,
      chunkBytes: 65_536, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(moves).toBe(0);
    expect(await readFile(destination)).toEqual(old);
    expect((await (await import("node:fs/promises")).readdir(root)).some(name => name.startsWith(".rcmcp-transfer-"))).toBe(false);
  });

  it("stops directory discovery before destination mutations after cancellation", async () => {
    const controller = new AbortController();
    let destinationMutations = 0;
    let destinationLists = 0;
    let sourceLists = 0;
    const client = {
      info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
      fsManage: async (device: string, input: { operation: string }) => {
        if (device === "source" && input.operation === "stat") return { isDirectory: true, size: 0 };
        if (device === "destination") destinationMutations += 1;
        return { ok: true };
      },
      fsList: async (device: string) => {
        if (device === "source") {
          sourceLists += 1;
          controller.abort();
          return [{ name: "late", path: "/source/late", type: "directory", size: 0 }];
        }
        destinationLists += 1;
        return [];
      },
    };
    await expect(syncDirectory(client as any, {
      sourceDevice: "source", sourcePath: "/source",
      destinationDevice: "destination", destinationPath: "/destination",
      compare: "size-mtime", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(sourceLists).toBe(1);
    expect(destinationMutations).toBe(0);
    expect(destinationLists).toBe(0);
  });

  it("replaces the destination only after a complete verified transfer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin"); const destination = path.join(root, "destination.bin");
    const data = Buffer.alloc(150_000, 0x42); await writeFile(source, data); await writeFile(destination, "old");
    const result = await transferFile(localClient() as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, chunkBytes: 65_536 });
    expect(result.atomic).toBe(true);
    expect(await readFile(destination)).toEqual(data);
  });
  it("propagates destination replacement atomicity from the transfer finalizer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin"); const destination = path.join(root, "destination.bin");
    await writeFile(source, "new"); await writeFile(destination, "old");
    const base = localClient() as any;
    const client = {
      ...base,
      fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
        const result = await base.fsManage(device, input);
        return input.operation === "transfer-finalize" ? { ...result, atomic: false, destinationAtomic: false } : result;
      },
    };
    const result = await transferFile(client as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination });
    expect(result).toMatchObject({ atomic: false, destinationAtomic: false });
    expect(await readFile(destination, "utf8")).toBe("new");
  });

  it("uses a short sibling temp name for valid long destination basenames", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin");
    const destination = path.join(root, `${"d".repeat(220)}.bin`);
    const data = Buffer.from("long-name-transfer");
    await writeFile(source, data);
    const result = await transferFile(localClient() as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, chunkBytes: 65_536 });
    expect(result.atomic).toBe(true);
    expect(await readFile(destination)).toEqual(data);
  });

  it.skipIf(process.platform === "win32")("uses destination OS semantics when Linux paths contain literal backslashes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-")); roots.push(root);
    const source = path.join(root, "source.bin");
    const destination = path.join(root, "a\\b", "destination.bin");
    const data = Buffer.from("literal-backslash-parent");
    await writeFile(source, data);
    await transferFile(localClient() as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, chunkBytes: 65_536 });
    expect(await readFile(destination)).toEqual(data);
  });

});


describe("M15 W5 relay cancellation propagation", () => {
  it("passes AbortSignal into relay reads and never writes a chunk returned after cancellation", async () => {
    const controller = new AbortController();
    let writes = 0;
    let moves = 0;
    let sawReadSignal = false;
    const client = {
      info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
      fsManage: async (device: string, input: { operation: string }) => {
        if (input.operation === "transfer-stage") return { temporaryPath: "/destination/stage/payload", directory: "/destination/stage", expectedDestination: "absent" };
        if (device === "source" && input.operation === "stat") {
          return { isFile: true, size: 16, modifiedAt: "2026-09-19T00:00:00.000Z" };
        }
        if (input.operation === "transfer-finalize") moves += 1;
        return { ok: true, isFile: true, size: 0 };
      },
      fsRead: async (_device: string, _input: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        sawReadSignal = options?.signal instanceof AbortSignal && !options.signal.aborted;
        controller.abort();
        // The whole-operation deadline composes caller and timer signals.
        // Verify actual cancellation propagation, not JavaScript object identity.
        expect(options?.signal?.aborted).toBe(true);
        expect(options?.signal?.reason).toBe(controller.signal.reason);
        return { data: Buffer.alloc(16, 0x61).toString("base64"), bytesRead: 16 };
      },
      fsWrite: async () => {
        writes += 1;
        return { ok: true };
      },
    };

    await expect(transferFile(client as any, {
      sourceDevice: "source", sourcePath: "/source/file.bin",
      destinationDevice: "destination", destinationPath: "/destination/file.bin",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(sawReadSignal).toBe(true);
    expect(writes).toBe(0);
    expect(moves).toBe(0);
  });
});
