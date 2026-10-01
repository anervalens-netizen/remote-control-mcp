import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
import { probeFleetHost } from "../apps/mcp-server/src/fleet-probe.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { search } from "../apps/agent/src/search.ts";
import { searchStart, searchResults, searchRemove } from "../apps/agent/src/search-sessions.ts";
import { mapLimit } from "../apps/mcp-server/src/concurrency.ts";

it("keeps responding agents reachable when metrics fail", async () => {
  const client = { info: async () => ({ hostname: "synthetic", readiness: "ready" }), requestRoute: async () => { throw Object.assign(new Error("private text"), { status: 500 }); } } as unknown as AgentClient;
  const value = await probeFleetHost(client, "synthetic", "system", 100);
  expect(value).toMatchObject({ online: true, connectivity: "reachable", metricsStatus: "unavailable" });
  expect(JSON.stringify(value)).not.toContain("private text");
});
it("bounds nonresponding probes and propagates cancellation without queued dispatch", async () => {
  const block = (_: unknown, __: unknown, options: { signal: AbortSignal }) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  const client = { info: block, requestRoute: (_: unknown, __: unknown, ___: unknown, ____: unknown, options: { signal: AbortSignal }) => block(_, __, options) } as unknown as AgentClient;
  const result = await probeFleetHost(client, "synthetic", "system", 100);
  expect(result).toMatchObject({ online: false, connectivity: "unknown" });
  const controller = new AbortController(); const seen: string[] = [];
  const pending = mapLimit(["one", "two", "three"], 1, async device => { seen.push(device); return probeFleetHost(client, device, "system", 1000, controller.signal); }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toThrow(); expect(seen).toEqual(["one"]);
});
describe("exact search limits", () => {
  for (const count of [0, 2, 3, 4]) it(`only truncates after an extra match: ${count}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-exact-"));
    try {
      await writeFile(path.join(root, "fixture.txt"), "needle\n".repeat(count));
      const result = await search({ path: root, pattern: "needle", maxResults: 3 }) as { results: unknown[]; limited: boolean };
      expect(result.results).toHaveLength(Math.min(count, 3)); expect(result.limited).toBe(count > 3);
      const started = await searchStart({ path: root, pattern: "needle", maxResults: 3 });
      try {
        let result = searchResults(started.id);
        for (let i = 0; result.status === "running" && i < 100; i++) { await new Promise(resolve => setTimeout(resolve, 20)); result = searchResults(started.id); }
        expect(result.status).toBe("done"); expect(result.available).toBe(Math.min(count, 3)); expect(result.limited).toBe(count > 3);
      } finally { await searchRemove(started.id, true); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
it("indexes over 1000 receipts with stable ties, corruption, deletion, additions and rebuild", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-index-"));
  try {
    await Promise.all(Array.from({ length: 1201 }, (_, i) => { const id = String(i).padStart(5, "0"); return writeFile(path.join(root, `${id}.json`), JSON.stringify({ id, startedAt: "2026-01-01T00:00:00.000Z", state: "completed", trackedProcesses: [{ opaque: true }] })); }));
    await writeFile(path.join(root, "corrupt.json"), "{broken");
    const index = new JobHistoryIndex(root); const ids: string[] = []; let cursor: string | undefined;
    do { const page = await index.page({ limit: 37, cursor }); ids.push(...page.ids); expect(page.corruptCount).toBe(1); cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(1201); expect(new Set(ids).size).toBe(1201); expect(ids[0]).toBe("01200");
    expect(await readFile(path.join(root, "corrupt.json"), "utf8")).toBe("{broken");
    await rm(path.join(root, "01200.json"));
    await writeFile(path.join(root, "new.json"), JSON.stringify({ id: "new", startedAt: "2026-02-01", state: "running" }));
    expect((await index.page({ limit: 1 })).ids).toEqual(["new"]);
    expect((await new JobHistoryIndex(root).page({ state: "running" })).ids).toEqual(["new"]);
    expect((await index.page({ state: "completed", limit: 1 })).ids).toEqual(["01199"]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15000);
