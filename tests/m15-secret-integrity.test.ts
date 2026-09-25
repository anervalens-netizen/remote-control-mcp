import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("M15 W4 secret integrity", () => {
  it("completes successful short writes before publishing an alias", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-secret-short-"));
    roots.push(root);

    const originalOpen = fsp.open;
    let inject = false;
    (fsp as any).open = async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args);
      if (inject && path.basename(String(args[0])).startsWith(".secret-") && args[1] === "wx") {
        const originalWrite = handle.write.bind(handle);
        (handle as any).write = async (buffer: Buffer, offset?: number, length?: number, position?: number | null) => {
          const bufferOffset = offset ?? 0;
          const requested = length ?? (buffer.length - bufferOffset);
          const one = Math.min(1, requested);
          return originalWrite(buffer, bufferOffset, one, position);
        };
      }
      return handle;
    };
    syncBuiltinESMExports();

    try {
      const { SecretStore } = await import("../apps/mcp-server/src/secret-store.ts");
      const store = new SecretStore(root);
      await store.put("alias", Buffer.from("OLD_TEST_VALUE"));
      inject = true;
      const published = await store.put("alias", Buffer.from("ABCDEF"));
      inject = false;
      expect(published).toMatchObject({ present: true, bytes: 6 });
      expect((await store.read("alias")).toString()).toBe("ABCDEF");
    } finally {
      (fsp as any).open = originalOpen;
      syncBuiltinESMExports();
    }
  });

  it("does not replace an old alias when a write makes zero progress", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-secret-zero-"));
    roots.push(root);

    const originalOpen = fsp.open;
    let inject = false;
    (fsp as any).open = async (...args: Parameters<typeof fsp.open>) => {
      const handle = await originalOpen(...args);
      if (inject && path.basename(String(args[0])).startsWith(".secret-") && args[1] === "wx") {
        (handle as any).write = async (buffer: Buffer) => ({ bytesWritten: 0, buffer });
      }
      return handle;
    };
    syncBuiltinESMExports();

    try {
      const { SecretStore } = await import("../apps/mcp-server/src/secret-store.ts");
      const store = new SecretStore(root);
      await store.put("alias", Buffer.from("OLD_TEST_VALUE"));
      inject = true;
      await expect(store.put("alias", Buffer.from("ABCDEF"))).rejects.toThrow(/progress|write/i);
      inject = false;
      expect((await store.read("alias")).toString()).toBe("OLD_TEST_VALUE");
    } finally {
      (fsp as any).open = originalOpen;
      syncBuiltinESMExports();
    }
  });

  it("revalidates a coherent remote source before publishing imported bytes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-secret-import-"));
    roots.push(root);
    const { SecretStore } = await import("../apps/mcp-server/src/secret-store.ts");
    const { importRemoteSecret } = await import("../apps/mcp-server/src/secret-tools.ts");
    const store = new SecretStore(root);
    await store.put("alias", Buffer.from("OLD_TEST_VALUE"));

    let stats = 0;
    const fakeClient = {
      fsManage: async () => {
        stats += 1;
        return stats === 1
          ? { isFile: true, size: 8, modifiedAt: "2026-09-19T00:00:00.000Z", dev: 1, ino: 10 }
          : { isFile: true, size: 8, modifiedAt: "2026-09-19T00:00:01.000Z", dev: 1, ino: 11 };
      },
      rawFile: async () => ({
        size: 8,
        modifiedAt: "2026-09-19T00:00:00.000Z",
        chunks: (async function* () {
          yield Buffer.from("AAAA");
          yield Buffer.from("BBBB");
        })(),
      }),
      fsRead: async (_device: string, input: { length: number }) => ({
        bytesRead: input.length,
        data: Buffer.alloc(input.length, 65).toString("base64"),
      }),
    } as unknown as AgentClient;

    await expect(importRemoteSecret(fakeClient, store, {
      alias: "alias", sourceDevice: "fixture", sourcePath: "/synthetic",
    })).rejects.toThrow(/changed|coherent|source/i);
    expect((await store.read("alias")).toString()).toBe("OLD_TEST_VALUE");
  });
});
