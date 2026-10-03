import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
it.each([100, 1000, 5000, 10000])("warm unchanged %i receipt history avoids 2N stats and own transitions stay fresh", async count => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-wave-"));
  try {
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => { while (next < count) { const id = String(next++).padStart(6, "0"); await writeFile(path.join(root, id + ".json"), JSON.stringify({ id, startedAt: "2026-01-01", state: "completed" })); } }));
    const index = new JobHistoryIndex(root);
    await index.activeIds(); await index.page({ limit: 10 });
    const baseline = { ...index.counters };
    const started = performance.now();
    await index.activeIds(); const page = await index.page({ limit: 10 });
    const warmMs = performance.now() - started;
    expect(index.counters).toEqual(baseline); expect(page.ids).toHaveLength(10);
    const before = index.beforeWrite(), meta = { id: "000000", startedAt: "2026-02-01", state: "running" };
    await writeFile(path.join(root, meta.id + ".json"), JSON.stringify(meta)); index.upsert(meta, before);
    expect(await index.activeIds()).toEqual([meta.id]); expect((await index.page({ state: "running" })).ids).toEqual([meta.id]);
    expect(index.counters).toEqual(baseline);
    console.log(JSON.stringify({ count, baselineWarmReceiptStats: 2 * count, afterWarmReceiptStats: index.counters.receiptStats - baseline.receiptStats, warmMs }));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
it("external in-place changes converge at the stated bound; additions/deletions and corrupt repairs converge immediately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-external-"));
  try {
    await writeFile(path.join(root, "one.json"), JSON.stringify({ id: "one", startedAt: "2026-01-01", state: "running" }));
    const index = new JobHistoryIndex(root); await index.page();
    await writeFile(path.join(root, "one.json"), JSON.stringify({ id: "one", startedAt: "2026-01-01", state: "completed" }));
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 1001);
    expect((await index.page({ state: "running" })).ids).toEqual([]);
    expect((await index.page({ state: "completed" })).ids).toEqual(["one"]);
    await writeFile(path.join(root, "new.json"), "{");
    expect((await index.page()).corruptCount).toBe(1);
    await rm(path.join(root, "one.json"));
    await writeFile(path.join(root, "new.json"), JSON.stringify({ id: "new", startedAt: "2026-01-01", state: "completed" }));
    expect(await index.page()).toMatchObject({ ids: ["new"], corruptCount: 0 });
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});
