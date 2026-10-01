import { it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, stat: async (file: string, ...args: unknown[]) => {
    if (path.basename(String(file)) === "delete-fixture.json") { await actual.rm(file, { force: true }); throw Object.assign(new Error("fixture disappeared"), { code: "ENOENT" }); }
    return actual.stat(file, ...(args as []));
  } };
});
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
it("counts a concurrent receipt deletion as unavailable rather than corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-delete-"));
  try {
    await writeFile(path.join(root, "delete-fixture.json"), JSON.stringify({ id: "delete-fixture", startedAt: "fixture", state: "completed" }));
    expect(await new JobHistoryIndex(root).page()).toMatchObject({ ids: [], corruptCount: 0, unavailableCount: 1, partial: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
