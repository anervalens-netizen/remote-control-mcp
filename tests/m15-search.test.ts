import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { search } from "../apps/agent/src/search.ts";
import { searchRemove, searchResults, searchStart } from "../apps/agent/src/search-sessions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-search-"));
  roots.push(root);
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "docs", "hidden.txt"), "NEEDLE docs\n");
  await writeFile(path.join(root, "src", "keep.txt"), "NEEDLE src\n");
  return root;
}

async function waitSearch(id: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = searchResults(id, 0, 1000);
    if (page.status !== "running") return page;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Search ${id} did not finish`);
}

function relativePaths(root: string, values: Array<{ path: string }>) {
  return values.map((value) => path.relative(root, value.path).replaceAll("\\", "/")).sort();
}

describe("M15 W2 rooted search semantics", () => {
  it("applies exclusion and inclusion globs relative to the requested directory", async () => {
    const root = await fixture();

    const excluded = await search({
      path: root, pattern: "NEEDLE", literal: true, globs: ["!docs/**"], maxResults: 10,
    }) as unknown as { results: Array<{ path: string }> };
    expect(relativePaths(root, excluded.results)).toEqual(["src/keep.txt"]);

    const included = await search({
      path: root, pattern: "NEEDLE", literal: true, globs: ["src/**"], maxResults: 10,
    }) as unknown as { results: Array<{ path: string }> };
    expect(relativePaths(root, included.results)).toEqual(["src/keep.txt"]);

    const files = await search({
      path: root, pattern: "txt", mode: "files", literal: true, globs: ["!docs/**"], maxResults: 10,
    }) as Array<{ path: string }>;
    expect(relativePaths(root, files)).toEqual(["src/keep.txt"]);
  });

  it("uses the same rooted glob semantics for persistent searches", async () => {
    const root = await fixture();
    const started = await searchStart({
      path: root, pattern: "NEEDLE", literal: true, globs: ["!docs/**"], maxResults: 10,
    });
    try {
      const done = await waitSearch(started.id);
      expect(done.status).toBe("done");
      expect(relativePaths(root, done.results as Array<{ path: string }>)).toEqual(["src/keep.txt"]);
    } finally {
      await searchRemove(started.id, true);
    }
  });
});

describe("M15 W2 invalid regex contracts", () => {
  it.each(["content", "files"] as const)("returns HTTP 400 for invalid %s regex with a literal-search hint", async (mode) => {
    const root = await fixture();
    const app = Fastify();
    registerExtraRoutes(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/search",
        payload: { path: root, pattern: "*", mode },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error?: string; message?: string };
      expect(body.error).toBe("invalid_argument");
      expect(body.message).toContain("literal=true");
    } finally {
      await app.close();
    }
  });

  it.each(["content", "files"] as const)("rejects invalid %s regex before creating a persistent search", async (mode) => {
    const root = await fixture();
    const app = Fastify();
    registerExtraRoutes(app);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/search/start",
        payload: { path: root, pattern: "*", mode },
      });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error?: string; message?: string };
      expect(body.error).toBe("invalid_argument");
      expect(body.message).toContain("literal=true");
    } finally {
      await app.close();
    }
  });
});

describe("M15 W2 bounded simple-search output", () => {
  it("bounds a single huge matching line and makes truncation explicit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-search-large-"));
    roots.push(root);
    await writeFile(path.join(root, "large.txt"), `NEEDLE ${"x".repeat(150_000)}\n`);

    const result = await search({
      path: root, pattern: "NEEDLE", literal: true, maxResults: 1,
    }) as unknown as {
      results: Array<{ text: string; textTruncated?: boolean }>;
      truncated?: boolean;
      limited: boolean;
    };

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.textTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});


describe("M15 W2 bounded file-search output", () => {
  it("bounds the legacy file array and leaves exhaustive retrieval to persistent paging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-file-search-large-"));
    roots.push(root);
    const count = 500;
    await Promise.all(Array.from({ length: count }, async (_, i) => {
      const name = `${String(i).padStart(4, "0")}-${"x".repeat(170)}.txt`;
      await writeFile(path.join(root, name), "fixture");
    }));

    const simple = await search({
      path: root, pattern: "txt", mode: "files", literal: true, maxResults: 10_000,
    }) as { results: Array<{ path: string }>; limited: true; truncated: true; byteTruncated: true };
    expect(simple.byteTruncated).toBe(true);
    expect(simple.limited).toBe(true);
    expect(simple.truncated).toBe(true);
    expect(simple.results.length).toBeGreaterThan(0);
    expect(simple.results.length).toBeLessThan(count);
    expect(Buffer.byteLength(JSON.stringify(simple), "utf8")).toBeLessThanOrEqual(64 * 1024);

    const started = await searchStart({
      path: root, pattern: "txt", mode: "files", literal: true, maxResults: count,
    });
    try {
      await waitSearch(started.id);
      const all: Array<{ path: string }> = [];
      let offset = 0;
      for (let pageNo = 0; pageNo < 20; pageNo += 1) {
        const page = searchResults(started.id, offset, 50);
        all.push(...page.results as Array<{ path: string }>);
        offset = page.nextOffset;
        if (page.eof) break;
      }
      expect(all).toHaveLength(count);
    } finally {
      await searchRemove(started.id, true);
    }
  });
});

describe("M15 W2 persistent result byte paging", () => {
  it("stops at a byte budget without advancing the cursor past unreturned results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-search-page-"));
    roots.push(root);
    await writeFile(
      path.join(root, "many.txt"),
      Array.from({ length: 30 }, (_, i) => `NEEDLE-${i} ${"x".repeat(480)}`).join("\n") + "\n",
    );
    const started = await searchStart({ path: root, pattern: "NEEDLE", literal: true, maxResults: 30 });
    try {
      await waitSearch(started.id);
      const all: Array<{ line: number }> = [];
      let cursor = 0;
      let offset = 0;
      let sawBudgetLimit = false;
      for (let pageNo = 0; pageNo < 20; pageNo += 1) {
        const page = searchResults(started.id, offset, 30, cursor, 4096);
        expect(page.pageBytes).toBeLessThanOrEqual(4096);
        if (page.pageLimited) sawBudgetLimit = true;
        all.push(...page.results as Array<{ line: number }>);
        offset = page.nextOffset;
        cursor = page.nextCursor ?? cursor;
        if (page.eof) break;
      }
      expect(sawBudgetLimit).toBe(true);
      expect(all.map((item) => item.line)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    } finally {
      await searchRemove(started.id, true);
    }
  });
});


describe("M15 W2 persistent pending-buffer bound", () => {
  it("fails a newline-free ripgrep record before retaining more than the configured pending limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-search-pending-"));
    roots.push(root);
    await writeFile(path.join(root, "huge.txt"), "NEEDLE " + "x".repeat(4 * 1024 * 1024 + 128 * 1024));
    const started = await searchStart({ path: root, pattern: "NEEDLE", literal: true, maxResults: 10 });
    try {
      const done = await waitSearch(started.id, 15_000);
      expect(done.status).toBe("error");
      expect(done.error).toMatch(/larger than|unterminated/i);
    } finally {
      await searchRemove(started.id, true);
    }
  }, 20_000);
});


describe.skipIf(process.platform === "win32")("M15 final strict first-record page budget", () => {
  it("does not exceed maxBytes when the first persisted file result is oversized and supports retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m15-search-first-record-"));
    roots.push(root);
    const segments = Array.from({ length: 7 }, (_, index) => String(index).padStart(2, "0") + "-" + "x".repeat(180));
    const deep = path.join(root, ...segments);
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "file-target.txt"), "fixture\n");
    const started = await searchStart({ path: root, pattern: "file-target", mode: "files", literal: true, maxResults: 1 });
    try {
      await waitSearch(started.id);

      const cursorPage = searchResults(started.id, 0, 1, 0, 1024);
      expect(cursorPage.results).toEqual([]);
      expect(cursorPage.pageBytes).toBe(0);
      expect(cursorPage.pageLimited).toBe(true);
      expect(cursorPage.requiredBytes).toBeGreaterThan(1024);
      expect(cursorPage.nextCursor).toBe(0);

      const cursorRetry = searchResults(started.id, 0, 1, 0, cursorPage.requiredBytes!);
      expect(cursorRetry.results).toHaveLength(1);
      expect(cursorRetry.pageBytes).toBeLessThanOrEqual(cursorRetry.maxBytes);
      expect(cursorRetry.nextCursor).toBeGreaterThan(0);

      const offsetPage = searchResults(started.id, 0, 1, undefined, 1024);
      expect(offsetPage.results).toEqual([]);
      expect(offsetPage.nextOffset).toBe(0);
      expect(offsetPage.requiredBytes).toBeGreaterThan(1024);

      const offsetRetry = searchResults(started.id, 0, 1, undefined, offsetPage.requiredBytes!);
      expect(offsetRetry.results).toHaveLength(1);
      expect(offsetRetry.pageBytes).toBeLessThanOrEqual(offsetRetry.maxBytes);
      expect(offsetRetry.nextOffset).toBe(1);
    } finally {
      await searchRemove(started.id, true);
    }
  });
});
