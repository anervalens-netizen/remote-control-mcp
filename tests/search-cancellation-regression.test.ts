import { mkdtemp, writeFile, rm, readFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
import { ensureStateDir } from "../apps/agent/src/state.ts";
import { searchSessionsDiagnostics, searchStart, searchResults, searchRemove } from "../apps/agent/src/search-sessions.ts";

it("preserves a corrupt search receipt while listing and reading valid sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-corrupt-"));
  const broken = path.join(ensureStateDir("search"), "corrupt-fixture.json");
  let id: string | undefined;
  try {
    await writeFile(path.join(root, "valid.txt"), "needle\n");
    id = (await searchStart({ path: root, pattern: "needle" })).id;
    await writeFile(broken, "{broken");
    const missing = path.join(ensureStateDir("search"), "missing-fields.json");
    await writeFile(missing, JSON.stringify({ id: "missing-fields", createdAt: "fixture", status: "done" }));
    const result = searchSessionsDiagnostics();
    expect(result).toMatchObject({ partial: true, corruptCount: 2 });
    expect(result.items.some(item => item.id === id)).toBe(true);
    expect(searchResults(id).id).toBe(id);
    expect(await readFile(broken, "utf8")).toBe("{broken");
  } finally { if (id) await searchRemove(id, true); await rm(broken, { force: true }); await rm(path.join(ensureStateDir("search"), "missing-fields.json"), { force: true }); await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "win32")("reaps the synchronous child even when it ignores SIGTERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-child-"));
  const fixture = path.join(root, "fixture-rg"); const pidFile = path.join(root, "pid.txt");
  const previous = process.env.RCMCP_RG_PATH;
  let pid: number | undefined;
  try {
    await writeFile(fixture, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
    await chmod(fixture, 0o700);
    process.env.RCMCP_RG_PATH = fixture; vi.resetModules();
    const { search } = await import("../apps/agent/src/search.ts");
    const controller = new AbortController(); const result = search({ path: root, pattern: "needle" }, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    for (let i = 0; i < 100; i++) { try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    expect(pid).toBeGreaterThan(0); controller.abort(); await rejected;
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (previous === undefined) delete process.env.RCMCP_RG_PATH; else process.env.RCMCP_RG_PATH = previous;
    vi.resetModules(); await rm(root, { recursive: true, force: true });
  }
});
