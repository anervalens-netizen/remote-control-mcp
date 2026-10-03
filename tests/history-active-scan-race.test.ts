import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});
afterEach(() => vi.restoreAllMocks());

it("activeIds and page preserve old while an in-flight initial scan races a local active update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-active-race-"));
  const active = { id: "active", startedAt: "2026-02-01", state: "running" };
  const old = { id: "old", startedAt: "2026-01-01", state: "completed" };
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    for (const meta of [active, old]) await writeFile(path.join(root, meta.id + ".json"), JSON.stringify(meta));
    const realRead = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).readFile;
    let reads = 0;
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const bytes = await realRead(...args);
      if (++reads === 2) ready.resolve();
      await release.promise;
      return bytes;
    }) as typeof readFile);
    const index = new JobHistoryIndex(root), scanning = index.activeIds();
    await ready.promise; // Both old values were read before the local transition.
    const updated = { ...active, state: "cancelling" };
    await writeFile(path.join(root, "active.json"), JSON.stringify(updated)); index.upsert(updated);
    release.resolve();
    expect(await scanning).toEqual(["active"]);
    expect(await index.page()).toMatchObject({ ids: ["active", "old"], partial: false, corruptCount: 0, unavailableCount: 0 });
    expect((await index.page({ state: "cancelling" })).ids).toEqual(["active"]);
    expect((await index.page({ state: "completed" })).ids).toEqual(["old"]);
    expect(index.counters.receiptReads).toBe(2);
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }); }
});
