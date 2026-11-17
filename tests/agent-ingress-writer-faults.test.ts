import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { IngressObserver } from "../apps/agent/src/ingress-observer.ts";

const directories: string[] = [];
const observers: IngressObserver[] = [];
const restorers: (() => void)[] = [];
const request = { route: "/health", method: "GET", entryPoint: "unattributed", authentication: "bearer_verified" } as const;
afterEach(async () => {
  for (const restore of restorers.splice(0).reverse()) restore();
  for (const observer of observers.splice(0)) observer.close();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ingress-writer-fault-"));
  directories.push(root); return root;
}
function observer(root: string) {
  const value = new IngressObserver({ identity: "owner", stateDirectory: root, instanceId: randomUUID() });
  observers.push(value); return value;
}
function fault(code: string) { return Object.assign(new Error("synthetic filesystem failure"), { code }); }
function patchFilesystem(make: (native: typeof fs) => Partial<typeof fs>) {
  const native = { ...fs };
  const overrides = make(native);
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, native[key as keyof typeof fs]]));
  Object.assign(fs, overrides); syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true; Object.assign(fs, previous); syncBuiltinESMExports();
  };
  restorers.push(restore); return restore;
}
function received(value: IngressObserver) { value.finish(value.begin(request), { statusCode: 200 }); }
function expectClosed(fd: number | undefined) {
  expect(fd).toBeTypeOf("number");
  expect(() => fs.fstatSync(fd!)).toThrow(expect.objectContaining({ code: "EBADF" }));
}

it.each(["write", "sync"] as const)("cleans its partial claim and descriptor when claim %s fails", async stage => {
  const root = await directory(), claim = path.join(root, "aggregate.json.writer");
  let ownedFd: number | undefined, injected = false;
  const restore = patchFilesystem(native => ({
    openSync(file, flags, mode) {
      const fd = native.openSync(file, flags, mode);
      if (file === claim) ownedFd = fd;
      return fd;
    },
    writeFileSync(file, data, options) {
      if (file === ownedFd && stage === "write") {
        injected = true;
        native.writeFileSync(file, '{"version":');
        throw fault("ENOSPC");
      }
      return native.writeFileSync(file, data, options);
    },
    fsyncSync(fd) {
      if (fd === ownedFd && stage === "sync") { injected = true; throw fault("EIO"); }
      return native.fsyncSync(fd);
    },
  }));
  const value = observer(root);
  received(value);
  expect(injected).toBe(true);
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_unavailable");
  expect(value.snapshot().totals).toMatchObject({ received: 1, completed: 1 });
  expect(fs.existsSync(claim)).toBe(false);
  expectClosed(ownedFd);
  restore();
  expect(observer(root).snapshot().coverage.persistence).toBe("confirmed");
});

it("closes a failed acquisition descriptor when its inode cannot be captured, preserving uncertain evidence", async () => {
  const root = await directory(), claim = path.join(root, "aggregate.json.writer");
  let ownedFd: number | undefined, injected = false;
  const restore = patchFilesystem(native => ({
    openSync(file, flags, mode) {
      const fd = native.openSync(file, flags, mode);
      if (file === claim) ownedFd = fd;
      return fd;
    },
    fstatSync: ((fd: number, options?: { bigint?: boolean }) => {
      if (fd === ownedFd && !injected) { injected = true; throw fault("EIO"); }
      return options?.bigint ? native.fstatSync(fd, { bigint: true }) : native.fstatSync(fd);
    }) as typeof fs.fstatSync,
  }));
  const value = observer(root);
  restore();
  expect(injected).toBe(true);
  expectClosed(ownedFd);
  expect(fs.readFileSync(claim, "utf8")).toBe("");
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_writer_release_failed");
  received(value);
  expect(value.snapshot().totals.completed).toBe(1);
  expect(observer(root).snapshot().coverage.faults).toContain("state_writer_locked");
});

it("preserves a replacement claim when partial creation fails and closes only its own descriptor", async () => {
  const root = await directory(), claim = path.join(root, "aggregate.json.writer");
  let ownedFd: number | undefined, injected = false;
  const replacement = "synthetic replacement claim";
  const restore = patchFilesystem(native => ({
    openSync(file, flags, mode) {
      const fd = native.openSync(file, flags, mode);
      if (file === claim) ownedFd = fd;
      return fd;
    },
    writeFileSync(file, data, options) {
      if (file === ownedFd && !injected) {
        injected = true;
        native.renameSync(claim, claim + ".original");
        native.writeFileSync(claim, replacement);
        throw fault("EIO");
      }
      return native.writeFileSync(file, data, options);
    },
  }));
  const value = observer(root);
  restore();
  expect(injected).toBe(true);
  expectClosed(ownedFd);
  expect(fs.readFileSync(claim, "utf8")).toBe(replacement);
  expect(value.snapshot().coverage.faults).toEqual(expect.arrayContaining(["state_unavailable", "state_writer_lost", "state_writer_release_failed"]));
  received(value); value.close();
  expect(fs.readFileSync(claim, "utf8")).toBe(replacement);
});

it("reports an actionable failed release and closes the descriptor without removing blocked claim evidence", async () => {
  const root = await directory(), file = path.join(root, "aggregate.json"), claim = file + ".writer";
  let ownedFd: number | undefined, injected = false;
  const capture = patchFilesystem(native => ({
    openSync(selected, flags, mode) {
      const fd = native.openSync(selected, flags, mode);
      if (selected === claim) ownedFd = fd;
      return fd;
    },
  }));
  const value = observer(root);
  capture();
  received(value);
  const before = fs.readFileSync(claim, "utf8");
  const restore = patchFilesystem(native => ({
    unlinkSync(selected) {
      if (selected === claim) { injected = true; throw fault("EACCES"); }
      return native.unlinkSync(selected);
    },
  }));
  expect(() => value.close()).not.toThrow();
  restore();
  expect(injected).toBe(true);
  expectClosed(ownedFd);
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_writer_release_failed");
  expect(fs.readFileSync(claim, "utf8")).toBe(before);
  expect(JSON.parse(fs.readFileSync(file, "utf8")).cleanShutdown).toBe(true);
  expect(observer(root).snapshot().coverage.faults).toContain("state_writer_locked");
});

it.skipIf(process.platform === "win32")("reports release durability failure when directory sync fails after unlink", async () => {
  const root = await directory(), claim = path.join(root, "aggregate.json.writer");
  const value = observer(root);
  let unlinked = false, injected = false;
  const restore = patchFilesystem(native => ({
    unlinkSync(file) {
      native.unlinkSync(file);
      if (file === claim) unlinked = true;
    },
    fsyncSync(fd) {
      if (unlinked && native.fstatSync(fd).isDirectory()) { injected = true; throw fault("EIO"); }
      native.fsyncSync(fd);
    },
  }));
  expect(() => value.close()).not.toThrow();
  restore();
  expect(injected).toBe(true);
  expect(fs.existsSync(claim)).toBe(false);
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_writer_release_failed");
  expect(observer(root).snapshot().coverage.persistence).toBe("confirmed");
});

it("fences an actually closed writer descriptor and preserves the last aggregate and claim", async () => {
  const root = await directory(), file = path.join(root, "aggregate.json"), claim = file + ".writer";
  let ownedFd: number | undefined;
  const restore = patchFilesystem(native => ({
    openSync(selected, flags, mode) {
      const fd = native.openSync(selected, flags, mode);
      if (selected === claim) ownedFd = fd;
      return fd;
    },
  }));
  const value = observer(root);
  restore();
  const before = fs.readFileSync(file, "utf8"), beforeClaim = fs.readFileSync(claim, "utf8");
  fs.closeSync(ownedFd!);
  received(value); value.flush(); value.close();
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_writer_lost");
  expect(value.snapshot().totals).toMatchObject({ received: 1, completed: 1 });
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.readFileSync(claim, "utf8")).toBe(beforeClaim);
});

it.each([
  { stage: "mkdir", code: "EACCES" },
  { stage: "mkdir", code: "EEXIST" },
  { stage: "open", code: "EACCES" },
] as const)("preserves a clean restart interval when $stage fails with $code before a claim exists", async ({ stage, code }) => {
  const root = await directory(), file = path.join(root, "aggregate.json"), claim = file + ".writer";
  const previous = observer(root); received(previous); previous.close();
  const retained = fs.readFileSync(file, "utf8");
  expect(JSON.parse(retained).cleanShutdown).toBe(true);
  expect(fs.existsSync(claim)).toBe(false);
  let injected = false;
  const restore = patchFilesystem(native => ({
    mkdirSync: ((selected: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
      if (selected === root && stage === "mkdir") { injected = true; throw fault(code); }
      return native.mkdirSync(selected, options);
    }) as typeof fs.mkdirSync,
    openSync(selected, flags, mode) {
      if (selected === claim && stage === "open") { injected = true; throw fault(code); }
      return native.openSync(selected, flags, mode);
    },
  }));
  const value = observer(root);
  restore();
  received(value); value.flush(); value.close();
  expect(injected).toBe(true);
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_unavailable");
  expect(value.snapshot().coverage.faults).not.toContain("state_writer_locked");
  expect(value.snapshot().history.gaps).toEqual([expect.objectContaining({
    reason: "clean_restart_interval", from: JSON.parse(retained).lastSavedAt, previousUnfinished: 0,
  })]);
  expect(value.snapshot().totals).toMatchObject({ received: 1, completed: 1 });
  expect(fs.existsSync(claim)).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(retained);
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([true, false])(
  "preserves the retained cleanShutdown=%s marker when a read-only directory prevents claim creation",
  async clean => {
    const root = await directory(), file = path.join(root, "aggregate.json"), claim = file + ".writer";
    const previous = observer(root);
    if (clean) received(previous); else previous.begin(request);
    previous.close();
    const retained = fs.readFileSync(file, "utf8"), saved = JSON.parse(retained);
    expect(saved.cleanShutdown).toBe(clean);
    expect(fs.existsSync(claim)).toBe(false);
    const mode = fs.statSync(root).mode & 0o777;
    fs.chmodSync(root, 0o500);
    restorers.push(() => fs.chmodSync(root, mode));
    const value = observer(root);
    expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
    expect(value.snapshot().coverage.faults).toContain("state_unavailable");
    expect(value.snapshot().coverage.faults).not.toContain("state_writer_locked");
    expect(value.snapshot().history.gaps).toEqual([expect.objectContaining({
      reason: clean ? "clean_restart_interval" : "unclean_restart",
      from: saved.lastSavedAt, previousUnfinished: clean ? 0 : 1,
    })]);
    received(value); value.flush(); value.close();
    expect(value.snapshot().totals).toMatchObject({ received: 1, completed: 1 });
    expect(fs.existsSync(claim)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(retained);
  },
);

it("does not publish a late completion after close released its descriptor", async () => {
  const root = await directory(), file = path.join(root, "aggregate.json");
  const value = observer(root);
  const handle = value.begin(request);
  value.close();
  const before = fs.readFileSync(file, "utf8");
  expect(JSON.parse(before)).toMatchObject({ cleanShutdown: false, previousUnfinished: 1 });
  value.finish(handle, { statusCode: 200 }); value.flush();
  expect(value.snapshot().coverage).toMatchObject({ persistence: "unavailable", repairRequired: true });
  expect(value.snapshot().coverage.faults).toContain("state_writer_lost");
  expect(fs.readFileSync(file, "utf8")).toBe(before);
  expect(fs.existsSync(file + ".writer")).toBe(false);
});
