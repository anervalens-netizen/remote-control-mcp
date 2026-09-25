import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteText } from "../apps/agent/src/state.ts";

const original = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
const roots: string[] = [];
afterEach(() => {
  Object.assign(fs, original); syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe("M16 state write transaction cleanup", () => {
  it("does not delete a temporary path it failed to create exclusively", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rcmcp-state-collision-")); roots.push(root);
    const target = path.join(root, "state.json"); fs.writeFileSync(target, "old");
    let foreign = "";
    (fs as any).openSync = (file: string, flags: string, mode?: number) => {
      if (flags === "wx") {
        foreign = file;
        original.writeFileSync(file, "foreign-writer", { flag: "w" });
        throw Object.assign(new Error("synthetic EEXIST"), { code: "EEXIST" });
      }
      return original.openSync(file, flags, mode);
    };
    syncBuiltinESMExports();
    expect(() => atomicWriteText(target, "new")).toThrow("synthetic EEXIST");
    expect(fs.readFileSync(foreign, "utf8")).toBe("foreign-writer");
    expect(fs.readFileSync(target, "utf8")).toBe("old");
  });
  for (const stage of ["write", "file-sync", "rename", "directory-sync"]) it.skipIf(stage === "directory-sync" && process.platform === "win32")(`preserves commit truth and removes staging after ${stage} failure`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rcmcp-state-fault-")); roots.push(root);
    const target = path.join(root, "state.json"); fs.writeFileSync(target, "old");
    let syncCalls = 0;
    const fail = () => { throw new Error("synthetic persistence failure"); };
    if (stage === "write") (fs as any).writeFileSync = fail;
    if (stage === "rename") (fs as any).renameSync = fail;
    if (stage.endsWith("sync")) (fs as any).fsyncSync = (fd: number) => {
      syncCalls++;
      if (syncCalls === (stage === "file-sync" ? 1 : 2)) fail();
      original.fsyncSync(fd);
    };
    syncBuiltinESMExports();
    let failure: any;
    try { atomicWriteText(target, "new"); } catch (error) { failure = error; }
    expect(failure?.message).toBe("synthetic persistence failure");
    expect(failure?.stateWrite).toMatchObject({ stage, committed: stage === "directory-sync", cleanupErrors: [] });
    expect(fs.readFileSync(target, "utf8")).toBe(stage === "directory-sync" ? "new" : "old");
    expect(fs.readdirSync(root)).toEqual(["state.json"]);
  });
});
