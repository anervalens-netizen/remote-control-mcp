import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { search } from "../apps/agent/src/search.ts";
import { buildSearchArgs } from "../apps/agent/src/search-common.ts";
import { searchRemove, searchResults, searchStart } from "../apps/agent/src/search-sessions.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function waitSearch(id: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = searchResults(id, 0, 1000);
    if (result.status !== "running") return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Search ${id} did not finish`);
}

describe("search streaming/options", () => {
  it("maps advanced traversal options directly to ripgrep without removing legacy options", () => {
    const built = buildSearchArgs({
      path: ".",
      pattern: "needle",
      literal: true,
      hidden: true,
      glob: "*.ts",
      globs: ["!dist/**", "*.tsx"],
      types: ["ts", "js"],
      excludeTypes: ["json"],
      follow: true,
      noIgnore: true,
      maxFileSizeBytes: 123456,
    });
    expect(built.args).toEqual(expect.arrayContaining([
      "--hidden", "--follow", "--no-ignore",
      "-g", "*.ts", "-g", "!dist/**", "-g", "*.tsx",
      "-t", "ts", "-t", "js", "-T", "json",
      "--max-filesize", "123456",
    ]));
    expect(built.args).toContain("-F");
  });

  it("streams persistent results with a byte cursor while preserving legacy offset semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-search-cursor-")); roots.push(root);
    await writeFile(path.join(root, "many.txt"), Array.from({ length: 250 }, (_, i) => `needle ${i}`).join("\n") + "\n");
    const started = await searchStart({ path: root, pattern: "needle", literal: true, maxResults: 250 });
    try {
      const done = await waitSearch(started.id);
      expect(done.available).toBe(250);
      const legacy = searchResults(started.id, 0, 250).results;
      const streamed: unknown[] = [];
      let cursor = 0;
      let offset = 0;
      let finalEof = false;
      for (let pageNo = 0; pageNo < 10 && streamed.length < legacy.length; pageNo += 1) {
        const page = searchResults(started.id, offset, 37, cursor);
        expect(page.cursor).toBe(cursor);
        expect(page.offset).toBe(offset);
        streamed.push(...page.results);
        cursor = page.nextCursor!;
        offset = page.nextOffset;
        finalEof = page.eof === true;
      }
      expect(streamed).toEqual(legacy);
      expect(offset).toBe(250);
      expect(cursor).toBeGreaterThan(0);
      expect(finalEof).toBe(true);
    } finally {
      await searchRemove(started.id, true);
    }
  });
});

describe("search reliability", () => {
  it("rejects an invalid file regex without destabilizing later searches", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-search-")); roots.push(root);
    await writeFile(path.join(root, "ok.txt"), "hello\n");
    await expect(searchStart({ path: root, pattern: "[", mode: "files" })).rejects.toThrow();
    const valid = await search({ path: root, pattern: "ok", mode: "files", literal: true });
    expect(valid).toHaveLength(1);
  });

  it("treats a pattern beginning with dash as data and parses non-UTF8 match bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-search-")); roots.push(root);
    await writeFile(path.join(root, "dash.txt"), "--version\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0x68,0x65,0x6c,0x6c,0x6f,0xff,0x0a]));
    const dash = await search({ path: root, pattern: "--version", literal: true, maxResults: 10 }) as { results: unknown[] };
    expect(dash.results).toHaveLength(1);
    const binary = await search({ path: root, pattern: "hello", literal: true, maxResults: 10 }) as { results: unknown[] };
    expect(binary.results).toHaveLength(1);
    expect((binary.results[0] as { text: string }).text).toContain("hello");
  });

  it("respects session maxResults and returns valid absolute paths for relative roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-search-rel-")); roots.push(root);
    for (let i = 0; i < 20; i += 1) await writeFile(path.join(root, `match-${i}.txt`), "x\n");
    const relative = path.relative(process.cwd(), root);
    const started = await searchStart({ path: relative, pattern: "match", mode: "files", literal: true, maxResults: 1 });
    try {
      const done = await waitSearch(started.id);
      expect(done.available, JSON.stringify(done)).toBe(1);
      expect(done.results).toHaveLength(1);
      const resultPath = (done.results[0] as { path: string }).path;
      expect(path.isAbsolute(resultPath)).toBe(true);
      expect(existsSync(resultPath)).toBe(true);
    } finally {
      await searchRemove(started.id, true);
    }
  });
});
