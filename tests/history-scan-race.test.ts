import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
afterEach(() => vi.restoreAllMocks());
it.each(["update-a", "update-b", "remove-b", "repair-b"])("initial scan preserves own writes and unrelated rows during %s", async action => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-race-"));
  const meta = (id: string, state = "running") => ({ id, startedAt: "2026-01-01", state });
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  try {
    for (const id of ["a", "b"]) await writeFile(path.join(root, id + ".json"), action === "repair-b" && id === "b" ? "{" : JSON.stringify(meta(id)));
    const original = vi.mocked(readFile).getMockImplementation()!;
    vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const bytes = await original(...args);
      if (args[0] === path.join(root, "b.json")) { entered(); await paused; }
      return bytes;
    }) as typeof readFile);
    const index = new JobHistoryIndex(root), pagePromise = index.page({ limit: 1 });
    await reading;
    const id = action === "update-a" ? "a" : "b", before = index.beforeWrite();
    if (action === "remove-b") { await rm(path.join(root, "b.json")); index.remove("b", before); }
    else { await writeFile(path.join(root, id + ".json"), JSON.stringify(meta(id, "completed"))); index.upsert(meta(id, "completed"), before); }
    release();
    const page = await pagePromise;
    expect(page).toMatchObject({ ids: [action === "remove-b" ? "a" : "b"], partial: false, corruptCount: 0, unavailableCount: 0 });
    if (action === "remove-b") expect(page.nextCursor).toBeNull();
    else {
      expect(page.nextCursor).not.toBeNull();
      expect(await index.page({ cursor: page.nextCursor!, limit: 1 })).toMatchObject({ ids: ["a"], nextCursor: null, partial: false });
      expect((await index.page({ state: "completed" })).ids).toEqual([id]);
    }
  } finally { release(); await rm(root, { recursive: true, force: true }); }
});
