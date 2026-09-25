import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { fsManage } from "../apps/agent/src/filesystem.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Issue #32 contracts", () => {
  it("guards the async identity matcher before any identity probe", () => {
    const source = readFileSync(path.resolve("apps/agent/src/process-identity.ts"), "utf8");
    const start = source.indexOf("export async function matchesStoredProcessIdentityAsync");
    const end = source.indexOf("\n}\n", start);
    const body = source.slice(start, end);
    expect(body).toContain("if (!storedIdentity) return false");
    expect(body.indexOf("if (!storedIdentity) return false")).toBeLessThan(body.indexOf("currentProcessIdentityAsync(pid)"));
  });

  it("skips descriptor syncing for non-regular filesystem targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue32-times-"));
    roots.push(root);
    const directory = path.join(root, "directory");
    await mkdir(directory);
    const result = await fsManage({ operation: "times", path: directory, modifiedAt: new Date(Date.now() - 60_000).toISOString() });
    expect(result).toMatchObject({
      ok: true,
      metadataSynced: false,
      metadataSyncSkipped: true,
      metadataSyncReason: "non_regular_target",
      durable: false,
    });
  });

  it.skipIf(process.platform === "win32")("does not block opening a FIFO just to sync timestamp metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue32-fifo-"));
    roots.push(root);
    const fifo = path.join(root, "target.fifo");
    execFileSync("mkfifo", [fifo]);
    const result = await Promise.race([
      fsManage({ operation: "times", path: fifo, modifiedAt: new Date(Date.now() - 30_000).toISOString() }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("FIFO metadata sync blocked")), 1500)),
    ]);
    expect(result).toMatchObject({ metadataSynced: false, metadataSyncSkipped: true, durable: false });
  });
});
