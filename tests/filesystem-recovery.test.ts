import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { fsList, fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";

const roots: string[] = [];
const canTestFileCapabilities = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0 && existsSync("/usr/sbin/setcap") && existsSync("/usr/sbin/getcap");
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("filesystem recoverability", () => {
  it("rewrites regular files durably without leaving staging files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-recovery-"));
    roots.push(root);
    const file = path.join(root, "atomic.txt");
    await fsWrite({ path: file, data: "old" });
    const result = await fsWrite({ path: file, data: "new-value" });
    expect(result).toMatchObject({ durable: true, replacedExisting: true, mode: "rewrite", writtenBytes: 9 });
    if (process.platform !== "win32") expect(result).toMatchObject({ directorySynced: true });
    expect(typeof result.atomic).toBe("boolean");
    expect((await fsRead({ path: file })).data).toBe("new-value");
    expect((await fsList({ path: root })).some((entry) => entry.name.startsWith(".rcmcp-write-") || entry.name.startsWith(".rcmcp-replace-"))).toBe(false);
  });


  it.skipIf(process.platform === "win32")("advances mtime when rewrite changes content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-mtime-"));
    roots.push(root);
    const file = path.join(root, "mtime.txt");
    await writeFile(file, "old");
    const oldTime = new Date("2020-01-02T03:04:05.000Z");
    await utimes(file, oldTime, oldTime);
    const before = await stat(file);
    await fsWrite({ path: file, data: "new" });
    const after = await stat(file);
    expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
    expect((await fsRead({ path: file })).data).toBe("new");
  });

  it.skipIf(process.platform === "win32")("preserves POSIX ownership and mode on atomic rewrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-metadata-"));
    roots.push(root);
    const file = path.join(root, "owned.txt");
    await writeFile(file, "old");
    await chmod(file, 0o640);
    const before = await stat(file);
    const result = await fsWrite({ path: file, data: "new" });
    const after = await stat(file);
    expect(result).toMatchObject({ metadataPreserved: true, metadataStrategy: "posix-all", directorySynced: true, durable: true });
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
  });

  it.skipIf(!canTestFileCapabilities)("preserves Linux file capabilities after staged content writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-capability-"));
    roots.push(root);
    const file = path.join(root, "capability.sh");
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
    execFileSync("/usr/sbin/setcap", ["cap_net_bind_service=ep", file]);
    expect(execFileSync("/usr/sbin/getcap", [file], { encoding: "utf8" })).toContain("cap_net_bind_service=ep");
    const result = await fsWrite({ path: file, data: "#!/bin/sh\nexit 0\n" });
    expect(result).toMatchObject({ metadataPreserved: true, metadataStrategy: "posix-all", durable: true });
    expect(execFileSync("/usr/sbin/getcap", [file], { encoding: "utf8" })).toContain("cap_net_bind_service=ep");
  });

  it.skipIf(process.platform === "win32")("rewrites owner-writable files that are intentionally unreadable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-writeonly-"));
    roots.push(root);
    const file = path.join(root, "write-only.txt");
    await writeFile(file, "old");
    await chmod(file, 0o200);
    const before = await stat(file);
    const result = await fsWrite({ path: file, data: "new" });
    const after = await stat(file);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(after.mode & 0o7777).toBe(0o200);
    expect(result).toMatchObject({ durable: true });
    expect(["basic", "posix-all"]).toContain(result.metadataStrategy);
    await chmod(file, 0o600);
    expect((await fsRead({ path: file })).data).toBe("new");
  });

  it.skipIf(process.platform === "win32")("syncs the containing directory when append creates a file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-append-"));
    roots.push(root);
    const file = path.join(root, "created-by-append.txt");
    const result = await fsWrite({ path: file, data: "first", mode: "append" });
    expect(result).toMatchObject({ mode: "append", created: true, durable: true, directorySynced: true });
    expect((await fsRead({ path: file })).data).toBe("first");
  });

  it.skipIf(process.platform === "win32")("preserves symlink write-through semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-recovery-"));
    roots.push(root);
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await writeFile(target, "old");
    await symlink(target, link);
    const result = await fsWrite({ path: link, data: "through-link" });
    expect(result).toMatchObject({ atomic: false, durable: true, directTarget: true, targetType: "symlink" });
    expect((await fsRead({ path: target })).data).toBe("through-link");
    expect((await fsList({ path: root })).find((entry) => entry.name === "link.txt")?.type).toBe("symlink");
  });

  it("honors move force=false and reports activation semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-recovery-"));
    roots.push(root);
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination.txt");
    await writeFile(source, "source");
    await writeFile(destination, "destination");
    await expect(fsManage({ operation: "move", path: source, destination, force: false })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await fsRead({ path: source })).data).toBe("source");
    expect((await fsRead({ path: destination })).data).toBe("destination");
    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({ ok: true, crossDevice: false, sourceRemoved: true });
    expect("atomic" in moved && typeof moved.atomic).toBe("boolean");
    expect((await fsRead({ path: destination })).data).toBe("source");
    await expect(fsManage({ operation: "stat", path: source })).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("treats an existing directory destination as the exact move path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-exact-move-"));
    roots.push(root);
    const source = path.join(root, "source.txt");
    const destination = path.join(root, "destination");
    await writeFile(source, "source");
    await mkdir(destination);

    await expect(fsManage({ operation: "move", path: source, destination, force: false })).rejects.toMatchObject({ code: "EEXIST" });
    expect((await fsRead({ path: source })).data).toBe("source");
    expect((await fsList({ path: destination })).some((entry) => entry.name === path.basename(source))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("allows only one force=false mover to claim an absent destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-no-clobber-"));
    roots.push(root);
    for (let i = 0; i < 5; i += 1) {
      const sourceA = path.join(root, `source-a-${i}.txt`);
      const sourceB = path.join(root, `source-b-${i}.txt`);
      const destination = path.join(root, `destination-${i}.txt`);
      await writeFile(sourceA, "A");
      await writeFile(sourceB, "B");
      const settled = await Promise.allSettled([
        fsManage({ operation: "move", path: sourceA, destination, force: false }),
        fsManage({ operation: "move", path: sourceB, destination, force: false }),
      ]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
      expect(rejected?.reason).toMatchObject({ code: "EEXIST" });
      const winner = (await fsRead({ path: destination })).data;
      expect(["A", "B"]).toContain(winner);
      const loser = winner === "A" ? sourceB : sourceA;
      expect((await fsRead({ path: loser })).data).toBe(winner === "A" ? "B" : "A");
    }
  });

  it.skipIf(process.platform === "win32")("moves readable non-writable files across filesystems without requiring write access", async () => {
    let destinationRoot: string;
    try { destinationRoot = await mkdtemp("/dev/shm/rcmcp-fs-readonly-"); } catch { return; }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-readonly-"));
    roots.push(sourceRoot, destinationRoot);
    if ((await stat(sourceRoot)).dev === (await stat(destinationRoot)).dev) return;
    const source = path.join(sourceRoot, "readonly.txt");
    const destination = path.join(destinationRoot, "readonly.txt");
    await writeFile(source, "READ_ONLY_DATA");
    await chmod(source, 0o444);

    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({
      ok: true, crossDevice: true, sourceRemoved: true,
      destinationDurable: true, sourceRemovalDurable: true,
      metadataPreserved: true, metadataStrategy: "posix-all",
    });
    expect((await stat(destination)).mode & 0o7777).toBe(0o444);
    expect((await fsRead({ path: destination })).data).toBe("READ_ONLY_DATA");
  });

  it("keeps cross-device deletion and committed replacement recovery semantics explicit", () => {
    const source = readFileSync(path.resolve("apps/agent/src/filesystem-atomic.ts"), "utf8");
    expect(source).toContain(".rcmcp-source-capture-");
    expect(source).toContain('recovery: "source_capture_cleanup_failed"');
    expect(source).toContain('recovery: "destination_activated_source_capture_retained"');
    expect(source).toContain("await replaceByRename(sourceCapture, source, false)");
    expect(source).toContain("if (!activated && backedUp)");
    expect(source).toContain("cleanupPending: true");
    expect(source).toContain("cleanupPath: backup");
  });

  it("uses full Windows directory metadata cloning instead of ACL-only reporting", () => {
    const source = readFileSync(path.resolve("apps/agent/src/filesystem-atomic.ts"), "utf8");
    expect(source).toContain("/COPY:DAT /DCOPY:DAT /SL /SJ");
    expect(source).toContain("Copy-RcmcpTreeMetadata");
    expect(source).toContain("[IO.File]::SetCreationTimeUtc");
    expect(source).toContain("[IO.File]::SetLastWriteTimeUtc");
    expect(source).toContain("compact.exe /C /I /Q");
    expect(source).not.toContain('metadataStrategy === "windows-acl"');
  });

  it.skipIf(process.platform === "win32")("preserves relative symlink text across cross-filesystem directory moves", async () => {
    let destinationRoot: string;
    try { destinationRoot = await mkdtemp("/dev/shm/rcmcp-fs-symlink-"); } catch { return; }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-symlink-"));
    roots.push(sourceRoot, destinationRoot);
    if ((await stat(sourceRoot)).dev === (await stat(destinationRoot)).dev) return;
    const source = path.join(sourceRoot, "tree");
    const destination = path.join(destinationRoot, "tree");
    await fsManage({ operation: "mkdir", path: source });
    await writeFile(path.join(source, "target"), "ok");
    await symlink("target", path.join(source, "link"));
    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({ ok: true, crossDevice: true, sourceRemoved: true });
    expect(await readlink(path.join(destination, "link"))).toBe("target");
  });

  it.skipIf(!canTestFileCapabilities)("preserves nested ownership, mode and capabilities on cross-filesystem directory moves", async () => {
    let destinationRoot: string;
    try { destinationRoot = await mkdtemp("/dev/shm/rcmcp-fs-tree-meta-"); } catch { return; }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-tree-meta-"));
    roots.push(sourceRoot, destinationRoot);
    if ((await stat(sourceRoot)).dev === (await stat(destinationRoot)).dev) return;

    const source = path.join(sourceRoot, "tree");
    const destination = path.join(destinationRoot, "tree");
    await fsManage({ operation: "mkdir", path: source });
    const child = path.join(source, "capability.sh");
    await writeFile(child, "#!/bin/sh\nexit 0\n");
    await chmod(source, 0o750);
    await chmod(child, 0o751);
    await chown(source, 65534, 65534);
    await chown(child, 65534, 65534);
    execFileSync("/usr/sbin/setcap", ["cap_net_bind_service=ep", child]);
    const sourceInfo = await stat(source);
    const childInfo = await stat(child);

    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({ ok: true, crossDevice: true, sourceRemoved: true, metadataPreserved: true, metadataStrategy: "posix-all" });
    const destinationInfo = await stat(destination);
    const destinationChild = path.join(destination, "capability.sh");
    const destinationChildInfo = await stat(destinationChild);
    expect({ uid: destinationInfo.uid, gid: destinationInfo.gid, mode: destinationInfo.mode & 0o7777 }).toEqual({
      uid: sourceInfo.uid, gid: sourceInfo.gid, mode: sourceInfo.mode & 0o7777,
    });
    expect({ uid: destinationChildInfo.uid, gid: destinationChildInfo.gid, mode: destinationChildInfo.mode & 0o7777 }).toEqual({
      uid: childInfo.uid, gid: childInfo.gid, mode: childInfo.mode & 0o7777,
    });
    expect(execFileSync("/usr/sbin/getcap", [destinationChild], { encoding: "utf8" })).toContain("cap_net_bind_service=ep");
  });

  it.skipIf(!canTestFileCapabilities)("preserves Linux file capabilities on cross-filesystem file moves", async () => {
    let destinationRoot: string;
    try { destinationRoot = await mkdtemp("/dev/shm/rcmcp-fs-cap-move-"); } catch { return; }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-cap-move-"));
    roots.push(sourceRoot, destinationRoot);
    if ((await stat(sourceRoot)).dev === (await stat(destinationRoot)).dev) return;
    const source = path.join(sourceRoot, "capability.sh");
    const destination = path.join(destinationRoot, "capability.sh");
    await writeFile(source, "#!/bin/sh\nexit 0\n");
    await chmod(source, 0o755);
    execFileSync("/usr/sbin/setcap", ["cap_net_bind_service=ep", source]);
    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({ ok: true, crossDevice: true, sourceRemoved: true, metadataPreserved: true, metadataStrategy: "posix-all" });
    expect(execFileSync("/usr/sbin/getcap", [destination], { encoding: "utf8" })).toContain("cap_net_bind_service=ep");
  });

  it.skipIf(process.platform === "win32")("recovers cross-filesystem moves through destination-side staging", async () => {
    let destinationRoot: string;
    try { destinationRoot = await mkdtemp("/dev/shm/rcmcp-fs-recovery-"); } catch { return; }
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "rcmcp-fs-recovery-"));
    roots.push(sourceRoot, destinationRoot);
    const sourceInfo = await fsManage({ operation: "stat", path: sourceRoot });
    const destinationInfo = await fsManage({ operation: "stat", path: destinationRoot });
    if (sourceInfo.dev === destinationInfo.dev) return;
    const source = path.join(sourceRoot, "source.txt");
    const destination = path.join(destinationRoot, "destination.txt");
    await writeFile(source, "cross-device");
    const moved = await fsManage({ operation: "move", path: source, destination, force: true });
    expect(moved).toMatchObject({ ok: true, atomic: false, crossDevice: true, sourceRemoved: true, destinationDurable: true, sourceRemovalDurable: true });
    expect((await fsRead({ path: destination })).data).toBe("cross-device");
    await expect(fsManage({ operation: "stat", path: source })).rejects.toThrow();
    expect((await fsList({ path: destinationRoot })).some((entry) => entry.name.startsWith(".rcmcp-move-") || entry.name.startsWith(".rcmcp-replace-"))).toBe(false);
  });
});
