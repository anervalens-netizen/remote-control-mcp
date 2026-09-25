import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverMoveCaptures } from "../apps/agent/src/filesystem-atomic.ts";
import { atomicWriteJson, ensureStateDir } from "../apps/agent/src/state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32" || !fs.existsSync("/dev/shm"))("M15 W4 EXDEV move source replacement", () => {
  it("never deletes a source pathname recreated after destination activation", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-move-src-"));
    const destinationRoot = await fsp.mkdtemp("/dev/shm/rcmcp-m15-move-dst-");
    roots.push(sourceRoot, destinationRoot);
    if ((await fsp.stat(sourceRoot)).dev === (await fsp.stat(destinationRoot)).dev) return;

    const source = path.join(sourceRoot, "source.txt");
    const destination = path.join(destinationRoot, "destination.txt");
    await fsp.writeFile(source, "ORIGINAL_BYTES");

    const originalRename = fsp.rename;
    let injected = false;
    (fsp as any).rename = async (from: string, to: string) => {
      const result = await originalRename(from, to);
      if (!injected && path.basename(String(from)).startsWith(".rcmcp-move-") && to === destination) {
        await fsp.writeFile(source, "CONCURRENT_NEW_DATA");
        injected = true;
      }
      return result;
    };
    syncBuiltinESMExports();

    try {
      const { movePath } = await import("../apps/agent/src/filesystem-atomic.ts");
      const moved = await movePath(source, destination, true);
      expect(injected).toBe(true);
      expect(moved.ok).toBe(true);
      expect(await fsp.readFile(destination, "utf8")).toBe("ORIGINAL_BYTES");
      expect(await fsp.readFile(source, "utf8")).toBe("CONCURRENT_NEW_DATA");
    } finally {
      (fsp as any).rename = originalRename;
      syncBuiltinESMExports();
    }
  });
});

describe("M15 W4 EXDEV move crash recovery", () => {
  it("restores a captured source from a durable journal after an interrupted move", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-move-recover-"));
    roots.push(sourceRoot);
    const id = randomUUID();
    const source = path.join(sourceRoot, "source.txt");
    const capture = path.join(sourceRoot, `.rcmcp-source-capture-${id}.tmp`);
    const journal = path.join(ensureStateDir("move-captures"), `${id}.json`);
    await fsp.writeFile(capture, "ORIGINAL_BYTES");
    atomicWriteJson(journal, { version: 1, source, capture, createdAt: new Date().toISOString() });

    const result = await recoverMoveCaptures();
    expect(result.errors).toEqual([]);
    expect(result.restored).toBeGreaterThanOrEqual(1);
    expect(await fsp.readFile(source, "utf8")).toBe("ORIGINAL_BYTES");
    expect(fs.existsSync(capture)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  it("never overwrites a replacement source during startup recovery", async () => {
    const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-move-retain-"));
    roots.push(sourceRoot);
    const id = randomUUID();
    const source = path.join(sourceRoot, "source.txt");
    const capture = path.join(sourceRoot, `.rcmcp-source-capture-${id}.tmp`);
    const journal = path.join(ensureStateDir("move-captures"), `${id}.json`);
    await fsp.writeFile(source, "CONCURRENT_NEW_DATA");
    await fsp.writeFile(capture, "ORIGINAL_BYTES");
    atomicWriteJson(journal, { version: 1, source, capture, createdAt: new Date().toISOString() });

    const result = await recoverMoveCaptures();
    expect(result.errors).toEqual([]);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    expect(await fsp.readFile(source, "utf8")).toBe("CONCURRENT_NEW_DATA");
    expect(await fsp.readFile(capture, "utf8")).toBe("ORIGINAL_BYTES");
    expect(fs.existsSync(journal)).toBe(true);
    await fsp.rm(capture, { force: true });
    await fsp.rm(journal, { force: true });
  });
});
