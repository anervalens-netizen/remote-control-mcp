import { existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { projectRun } from "../apps/agent/src/project-run.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.doUnmock("node:fs/promises"); vi.resetModules();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rc25-lifecycle-")); roots.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "dest");
  await fs.writeFile(source, "payload");
  return { root, source, destination };
}
function abortWhen(predicate: () => boolean): AbortSignal {
  const controller = new AbortController();
  return {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    throwIfAborted() { if (predicate()) controller.abort(); controller.signal.throwIfAborted(); },
  } as AbortSignal;
}

it("reports no effects on pre-abort, including a missing source", async () => {
  const { source, destination } = await fixture();
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  for (const from of [source, source + "-missing"]) {
    expect(await copyPath(from, destination, true, true, AbortSignal.abort())).toMatchObject({
      copied: 0, skipped: 0, cancelled: true, partialEffectsPossible: false,
    });
  }
  expect(existsSync(destination)).toBe(false);
});
it("catches preflight cancellation before any mutation", async () => {
  const { source, destination } = await fixture();
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true, abortWhen(() => true))).toMatchObject({
    copied: 0, cancelled: true, partialEffectsPossible: false,
  });
  expect(existsSync(destination)).toBe(false);
});
it("returns parent creation effects when abort arrives after recursive mkdir", async () => {
  const { root, source } = await fixture();
  const parent = path.join(root, "new", "parent"), destination = path.join(parent, "dest");
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true, abortWhen(() => existsSync(parent)))).toMatchObject({
    copied: 0, cancelled: true, partialEffectsPossible: true, outcome: "partial",
  });
  expect(existsSync(parent)).toBe(true); expect(existsSync(destination)).toBe(false);
});
it("reports unlink without copy as a partial effect", async () => {
  const { source, destination } = await fixture(); await fs.writeFile(destination, "old");
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true, abortWhen(() => !existsSync(destination)))).toMatchObject({
    copied: 0, cancelled: true, partialEffectsPossible: true, outcome: "partial",
  });
  expect(existsSync(destination)).toBe(false);
});
it.skipIf(process.platform === "win32")("restores 0444 after an abort observes the real temporary 0644 mode", async () => {
  const { source, destination } = await fixture(); await fs.chmod(source, 0o444);
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  let observed = false;
  const signal = abortWhen(() => observed ||= existsSync(destination) && (statSync(destination).mode & 0o777) === 0o644);
  const result = await copyPath(source, destination, true, true, signal);
  expect(observed).toBe(true); expect(result).toMatchObject({ copied: 1, cancelled: true });
  expect(statSync(destination).mode & 0o777).toBe(0o444);
});
it.skipIf(process.platform === "win32").each(["stat", "utimes"] as const)("restores real file permissions after %s fails", async (operation) => {
  const { source, destination } = await fixture(); await fs.chmod(source, 0o444);
  let observed = false;
  vi.doMock("node:fs/promises", () => ({ ...fs, [operation]: async () => {
    observed = (statSync(destination).mode & 0o777) === 0o644;
    throw new Error("metadata fixture failed");
  } }));
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true)).toMatchObject({ ok: false, copied: 1, error: "metadata fixture failed" });
  expect(observed).toBe(true); expect(statSync(destination).mode & 0o777).toBe(0o444);
});
it.skipIf(process.platform === "win32").each(["abort", "error"])("restores 0500 directory after mid-traversal %s", async (failure) => {
  const { source, destination } = await fixture(); await fs.unlink(source); await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "payload"); await fs.chmod(source, 0o500);
  let observed = false;
  vi.doMock("node:fs/promises", () => ({ ...fs, readdir: async (...args: Parameters<typeof fs.readdir>) => {
    observed = (statSync(destination).mode & 0o777) === 0o700;
    if (failure === "error") throw new Error("directory fixture failed");
    return fs.readdir(...args);
  } }));
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  const result = await copyPath(source, destination, true, true, failure === "abort" ? abortWhen(() => existsSync(path.join(destination, "child"))) : undefined);
  expect(result.ok).toBe(false); expect(observed).toBe(true);
  expect(statSync(destination).mode & 0o777).toBe(0o500);
  await fs.chmod(destination, 0o700); await fs.chmod(source, 0o700);
});
it.skipIf(process.platform === "win32")("does not call a cooperative zero-exit SIGTERM cancellation successful", async () => {
  const { root } = await fixture(), ready = path.join(root, "ready");
  const controller = new AbortController();
  const running = projectRun({ path: root, executable: process.execPath, args: ["-e", `const fs=require('node:fs'); process.on('SIGTERM',()=>process.exit(0)); fs.writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`], mode: "exec", timeoutMs: 0 }, controller.signal);
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5000 });
    controller.abort();
    expect(await running).toMatchObject({ ok: false, result: { code: 0, cancelled: true, cancellationRequested: true, timedOut: false } });
  } finally { controller.abort(); await running; }
}, 10_000);

it("waits for a native in-flight copy and reports its bytes without claiming rollback", async () => {
  const { source, destination } = await fixture(); const controller = new AbortController();
  vi.doMock("node:fs/promises", () => ({ ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
    const pending = fs.copyFile(...args);
    controller.abort();
    await pending;
  } }));
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true, controller.signal)).toMatchObject({ copied: 1, cancelled: true, partialEffectsPossible: true });
  expect(await fs.readFile(destination, "utf8")).toBe("payload");
});
it.skipIf(process.platform === "win32")("restores permissions even if temporary chmod changes the real mode and then fails", async () => {
  const { source, destination } = await fixture(); await fs.chmod(source, 0o444);
  let observed = false;
  vi.doMock("node:fs/promises", () => ({ ...fs, chmod: async (...args: Parameters<typeof fs.chmod>) => {
    await fs.chmod(...args);
    if (args[1] === 0o644) { observed = (statSync(destination).mode & 0o777) === 0o644; throw new Error("chmod fixture failed"); }
  } }));
  const { copyPath } = await import("../apps/agent/src/filesystem-copy.ts");
  expect(await copyPath(source, destination, true, true)).toMatchObject({ ok: false, copied: 1, error: "chmod fixture failed" });
  expect(observed).toBe(true); expect(statSync(destination).mode & 0o777).toBe(0o444);
});
