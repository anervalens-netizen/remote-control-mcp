// Synthetic, bounded benchmark; no agent state or private receipt is opened.
import { mkdtemp, writeFile, stat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
for (const count of [100, 1000, 5000, 10000, 100000]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-history-benchmark-"));
  try {
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => { while (next < count) { const id = String(next++).padStart(6, "0"); await writeFile(path.join(root, `${id}.json`), JSON.stringify({ id, state: "completed", startedAt: "2026-01-01" })); } }));
    // Previous warm scan cost: two directory listings and one stat per receipt
    // in each scan, eight workers, zero JSON reads. Same corpus and machine.
    const oldStart = performance.now();
    for (let pass = 0; pass < 2; pass++) {
      const names = await readdir(root); let i = 0;
      await Promise.all(Array.from({ length: 8 }, async () => { while (i < names.length) await stat(path.join(root, names[i++]!)); }));
    }
    const beforeMs = performance.now() - oldStart;
    const index = new JobHistoryIndex(root), coldStart = performance.now();
    await index.activeIds(); await index.page({ limit: 10 });
    const coldMs = performance.now() - coldStart, before = { ...index.counters }, warmStart = performance.now();
    await index.activeIds(); await index.page({ limit: 10 });
    console.log(JSON.stringify({ count, beforeWarmScanMs: beforeMs, beforeWarmReceiptStats: count * 2, coldMs, afterWarmMs: performance.now() - warmStart,
      afterWarmReceiptStats: index.counters.receiptStats - before.receiptStats, afterWarmReads: index.counters.receiptReads - before.receiptReads }));
  } finally { await rm(root, { recursive: true, force: true }); }
}
