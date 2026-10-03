import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, stat: async (file: string, options?: any) => {
    const result = await fs.stat(file, options);
    // Simulate a coarse filesystem clock that exposes the same stamps for
    // namespace changes and same-size content edits. File bytes are real.
    return { ...result, mtimeMs: 1, ctimeMs: 1, mtimeNs: 1n, ctimeNs: 1n };
  } };
});
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
afterEach(() => vi.restoreAllMocks());
it("detects namespace changes with identical directory stamps and bounds same-size content collisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-collision-"));
  const receipt = (id: string, state: string) => JSON.stringify({ id, startedAt: "2026-01-01", state });
  try {
    await writeFile(path.join(root, "one.json"), receipt("one", "completed"));
    const index = new JobHistoryIndex(root); expect((await index.page()).ids).toEqual(["one"]);
    await rm(path.join(root, "one.json")); await writeFile(path.join(root, "two.json"), receipt("two", "completed"));
    expect((await index.page()).ids).toEqual(["two"]);
    // completed and cancelled have equal lengths; inode/size/stamps stay equal.
    await writeFile(path.join(root, "two.json"), receipt("two", "cancelled"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30001);
    expect((await index.page({ state: "cancelled" })).ids).toEqual(["two"]);
    expect((await index.page()).freshness.externalMaxAgeMs).toBe(30000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
