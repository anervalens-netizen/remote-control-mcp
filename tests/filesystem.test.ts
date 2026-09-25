import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsList, fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("filesystem primitives", () => {
  it("write/read/list/copy/stat/delete without path restrictions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const a = path.join(root, "a.txt");
    const b = path.join(root, "b.txt");

    await fsWrite({ path: a, data: "alpha\nbeta\n" });
    expect((await fsRead({ path: a })).data).toBe("alpha\nbeta\n");
    await fsManage({ operation: "copy", path: a, destination: b });
    expect((await fsList({ path: root })).map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"]);
    expect((await fsManage({ operation: "stat", path: b })).size).toBe(11);
    await fsManage({ operation: "delete", path: b });
    expect((await fsList({ path: root })).map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it.skipIf(process.platform === "win32")("reads virtual files whose stat size is zero", async () => {
    const result = await fsRead({ path: "/proc/self/status" });
    expect(result.bytesRead).toBeGreaterThan(0);
    expect(result.data).toContain("Name:");
  });

  it.skipIf(process.platform === "win32")("keeps listing when a directory contains a dangling symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    await writeFile(path.join(root, "good.txt"), "ok");
    await symlink(path.join(root, "missing-target"), path.join(root, "broken-link"));
    const entries = await fsList({ path: root });
    expect(entries.map((entry) => entry.name).sort()).toEqual(["broken-link", "good.txt"]);
    expect(entries.find((entry) => entry.name === "broken-link")?.type).toBe("symlink");
  });

  it.skipIf(process.platform === "win32")("bounds omitted-length reads from non-EOF zero-sized devices", async () => {
    const result = await fsRead({ path: "/dev/zero" });
    expect(result.bytesRead).toBe(1024 * 1024);
    expect(result.nextOffset).toBe(1024 * 1024);
    expect(result.eof).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects tail/line modes on unknown-size virtual streams without losing byte paging", async () => {
    await expect(fsRead({ path: "/proc/self/status", tailBytes: 64 })).rejects.toThrow("known-size file");
    await expect(fsRead({ path: "/proc/self/status", startLine: 1, lineCount: 2 })).rejects.toThrow("known-size file");
    expect((await fsRead({ path: "/proc/self/status", length: 64 })).bytesRead).toBeGreaterThan(0);
  });

  it("paginates large regular files by default while preserving explicit reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "large.bin");
    await writeFile(file, Buffer.alloc(1024 * 1024 + 32, 0x41));
    const first = await fsRead({ path: file, encoding: "base64" });
    expect(first.bytesRead).toBe(1024 * 1024);
    expect(first.eof).toBe(false);
    const second = await fsRead({ path: file, offset: first.nextOffset, encoding: "base64" });
    expect(second.bytesRead).toBe(32);
    expect(second.eof).toBe(true);
  });

  it.skipIf(process.platform === "win32")("honors explicit lengths for zero-sized non-EOF devices", async () => {
    const result = await fsRead({ path: "/dev/zero", length: 2 * 1024 * 1024, encoding: "base64" });
    expect(result.bytesRead).toBe(2 * 1024 * 1024);
    expect(result.nextOffset).toBe(2 * 1024 * 1024);
    expect(result.eof).toBe(false);
  });

  it("keeps UTF-8 characters intact across default pages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "utf8.txt");
    const value = `${"a".repeat(1024 * 1024 - 1)}€tail`;
    await writeFile(file, value, "utf8");
    const first = await fsRead({ path: file });
    const second = await fsRead({ path: file, offset: first.nextOffset });
    expect(first.data + second.data).toBe(value);
    expect(first.data).not.toContain("�");
    expect(second.data).not.toContain("�");
    expect(first.nextOffset).toBe(1024 * 1024 - 1);
  });

  it("consumes an incomplete UTF-8 tail at EOF instead of returning a non-progressing page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "incomplete-utf8.bin");
    await writeFile(file, Buffer.from([0xe2]));
    const result = await fsRead({ path: file });
    expect(result).toMatchObject({ bytesRead: 1, nextOffset: 1, eof: true });
    expect(result.data).toBe("�");
  });

  it("tails bounded UTF-8 content without returning a split leading character", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "tail.txt");
    await writeFile(file, "prefix€tail", "utf8");
    const result = await fsRead({ path: file, tailBytes: 6 });
    expect(result.data).toBe("tail");
    expect(result.bytesRead).toBe(4);
    expect(result.eof).toBe(true);
    expect(result.nextOffset).toBe(Buffer.byteLength("prefix€tail"));
  });

  it("reads bounded 1-based line ranges while preserving original line endings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "lines.txt");
    await writeFile(file, "zero\none\r\ntwo\nthree\nfour", "utf8");
    const result = await fsRead({ path: file, startLine: 2, lineCount: 2, maxBytes: 1024 });
    expect(result).toMatchObject({ data: "one\r\ntwo\n", linesRead: 2, nextLine: 4, truncated: false, eof: false });
  });

  it("extends a tiny line page through the first complete UTF-8 code point", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "utf8-line.txt");
    await writeFile(file, "€tail\n", "utf8");
    const result = await fsRead({ path: file, startLine: 1, lineCount: 1, maxBytes: 1 });
    expect(result).toMatchObject({ data: "€", bytesRead: 3, nextOffset: 3, linesRead: 0, nextLine: 1, truncated: true, partialLine: true, eof: false });
    expect(result.data).not.toContain("�");
  });

  it("bounds a single oversized line and exposes byte continuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "long-line.txt");
    await writeFile(file, "abcdef\nnext\n", "utf8");
    const result = await fsRead({ path: file, startLine: 1, lineCount: 2, maxBytes: 4 });
    expect(result).toMatchObject({ data: "abcd", bytesRead: 4, nextOffset: 4, linesRead: 0, nextLine: 1, truncated: true, partialLine: true, eof: false });
    expect("nextLine" in result).toBe(true);
    const nextLine = "nextLine" in result ? result.nextLine : 1;
    const continued = await fsRead({ path: file, startLine: nextLine, lineCount: 2, maxBytes: 4, offset: result.nextOffset });
    expect(continued).toMatchObject({ data: "ef\n", byteOffset: 4, nextOffset: 7, linesRead: 1, nextLine: 2, truncated: true, partialLine: false, eof: false });
  });

  it("stops before the next complete line when the line page is full", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "bounded-lines.txt");
    await writeFile(file, "aa\nbbbb\ncc\n", "utf8");
    const result = await fsRead({ path: file, startLine: 1, lineCount: 3, maxBytes: 4 });
    expect(result).toMatchObject({ data: "aa\n", linesRead: 1, nextLine: 2, nextOffset: 3, truncated: true, partialLine: false, eof: false });
  });

  it("makes forward progress for short explicit UTF-8 byte reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-"));
    roots.push(root);
    const file = path.join(root, "short-utf8.txt");
    await writeFile(file, "€tail", "utf8");
    const first = await fsRead({ path: file, length: 1 });
    expect(first.bytesRead).toBe(1);
    expect(first.nextOffset).toBe(1);
    expect(first.eof).toBe(false);
  });

});
