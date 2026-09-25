import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { importRemoteSecret, installSecret, renderSecretTemplate } from "../apps/mcp-server/src/secret-tools.ts";
import { SecretStore } from "../apps/mcp-server/src/secret-store.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function memoryClient(seed: Record<string, Buffer> = {}, moveAtomic = true) {
  const files = new Map<string, Buffer>(Object.entries(seed));
  const writes: Array<Record<string, unknown>> = [];
  const client = {
    info: async () => ({ platform: "linux" }),
    fsWrite: async (_device: string, input: { path: string; data: string; encoding?: string; mode?: string; permissions?: number }) => {
      writes.push({ ...input, data: "<redacted>" });
      const data = input.encoding === "base64" ? Buffer.from(input.data, "base64") : Buffer.from(input.data, "utf8");
      files.set(input.path, input.mode === "append" ? Buffer.concat([files.get(input.path) ?? Buffer.alloc(0), data]) : data);
      return { path: input.path, bytes: files.get(input.path)!.length };
    },
    fsRead: async (_device: string, input: { path: string; offset?: number; length?: number }) => {
      const source = files.get(input.path);
      if (!source) throw new Error(`missing ${input.path}`);
      const offset = input.offset ?? 0;
      const data = source.subarray(offset, offset + (input.length ?? source.length));
      return { data: data.toString("base64"), bytesRead: data.length };
    },
    rawFile: async (_device: string, sourcePath: string) => {
      const source = files.get(sourcePath);
      if (!source) throw new Error(`missing ${sourcePath}`);
      return {
        size: source.length,
        modifiedAt: null,
        chunks: (async function* () { yield Buffer.from(source); })(),
      };
    },
    fsManage: async (_device: string, input: { operation: string; path: string; destination?: string }) => {
      if (input.operation === "stat") {
        const data = files.get(input.path);
        if (!data) throw new Error(`missing ${input.path}`);
        return { size: data.length, isFile: true };
      }
      if (input.operation === "move") {
        const data = files.get(input.path);
        if (!data || !input.destination) throw new Error("invalid move");
        files.set(input.destination, data); files.delete(input.path);
        return { ok: true, atomic: moveAtomic, destinationAtomic: moveAtomic };
      }
      if (input.operation === "delete") { files.delete(input.path); return { ok: true }; }
      throw new Error(`unsupported ${input.operation}`);
    },
  } as unknown as AgentClient;
  return { client, files, writes };
}

async function storeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-secrets-"));
  roots.push(root);
  return new SecretStore(root);
}

describe("secret broker", () => {
  it("stores arbitrary aliases while metadata never exposes secret content", async () => {
    const store = await storeFixture();
    const marker = "TOP-SECRET-VALUE";
    const meta = await store.put("provider/key with spaces", Buffer.from(marker));
    expect(meta).toMatchObject({ alias: "provider/key with spaces", present: true, bytes: marker.length });
    expect(JSON.stringify(meta)).not.toContain(marker);
    expect(JSON.stringify(await store.list())).not.toContain(marker);
    expect((await store.read("provider/key with spaces")).toString()).toBe(marker);
    expect(await store.delete("provider/key with spaces")).toEqual({ alias: "provider/key with spaces", deleted: true });
    expect(await store.metadata("provider/key with spaces")).toEqual({ alias: "provider/key with spaces", present: false });
  });

  it("cleans partial secret staging if a streamed import fails", async () => {
    const store = await storeFixture();
    async function* broken() { yield Buffer.from("partial"); throw new Error("stream failed"); }
    await expect(store.putChunks("broken", broken())).rejects.toThrow("stream failed");
    const dirs = await readdir(store.root, { withFileTypes: true });
    for (const dir of dirs.filter((item) => item.isDirectory())) {
      const files = await readdir(path.join(store.root, dir.name));
      expect(files.filter((name) => name.includes(".tmp"))).toEqual([]);
    }
    expect(await store.metadata("broken")).toEqual({ alias: "broken", present: false });
  });

  it("serializes same-alias mutation and recovery reads", async () => {
    const store = await storeFixture();
    const alias = "serialized";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    async function* slowSecret() {
      markStarted();
      yield Buffer.from("first-");
      await release;
      yield Buffer.from("value");
    }

    const first = store.putChunks(alias, slowSecret());
    await started;
    let secondSettled = false;
    const second = store.put(alias, Buffer.from("second-value")).finally(() => { secondSettled = true; });
    let metadataSettled = false;
    const metadata = store.metadata(alias).finally(() => { metadataSettled = true; });
    let listSettled = false;
    const listed = store.list().finally(() => { listSettled = true; });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondSettled).toBe(false);
    expect(metadataSettled).toBe(false);
    expect(listSettled).toBe(false);

    releaseFirst();
    await first;
    await second;
    expect(await store.read(alias)).toEqual(Buffer.from("second-value"));
    await expect(metadata).resolves.toMatchObject({ alias, present: true, bytes: 12 });
    await expect(listed).resolves.toContainEqual(expect.objectContaining({ alias, present: true }));
    const entry = (await readdir(store.root, { withFileTypes: true })).find((item) => item.isDirectory());
    expect(entry).toBeTruthy();
    expect((await readdir(path.join(store.root, entry!.name))).filter((name) => name.includes(".tmp") || name.includes(".bak") || name === "replace.json")).toEqual([]);
  });

  it("reclaims a legacy stale lock when its PID has been reused", async () => {
    const store = await storeFixture();
    const alias = "legacy-reused-pid";
    const key = createHash("sha256").update(alias, "utf8").digest("hex");
    const lockDir = path.join(store.root, ".lock-" + key);
    await writeFile(path.join(store.root, ".touch"), "");
    await mkdir(lockDir, { recursive: true });
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "stale-owner",
      createdAt: "2000-01-01T00:00:00.000Z",
    }) + "\n");

    // Reclamation must not enter the25ms lock-contention backoff. Native Windows
    // encryption, ACL setup and process evidence are not a2s lock-wait contract.
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(store.put(alias, Buffer.from("fresh"))).resolves.toMatchObject({ alias, present: true });
      expect(timers.mock.calls.some(([, delay]) => delay === 25)).toBe(false);
    } finally { timers.mockRestore(); }
    expect((await readdir(store.root)).filter((name) => name.startsWith(".lock-"))).toEqual([]);
    expect((await store.read(alias)).toString()).toBe("fresh");
  });

  it.skipIf(process.platform === "win32")("reclaims a lock whose PID/start tick came from another boot", async () => {
    const store = await storeFixture();
    const alias = "cross-boot-lock";
    const key = createHash("sha256").update(alias, "utf8").digest("hex");
    const lockDir = path.join(store.root, ".lock-" + key);
    await mkdir(lockDir, { recursive: true });
    const raw = await readFile("/proc/" + process.pid + "/stat", "utf8");
    const close = raw.lastIndexOf(")");
    const startTicks = raw.slice(close + 1).trim().split(/\s+/)[19];
    if (!startTicks) throw new Error("missing current start ticks");
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({
      pid: process.pid,
      token: "stale-other-boot",
      createdAt: new Date().toISOString(),
      processIdentity: "linux:00000000-0000-0000-0000-000000000000:" + startTicks,
    }) + "\n");

    const started = Date.now();
    await expect(store.put(alias, Buffer.from("fresh"))).resolves.toMatchObject({ alias, present: true });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await store.read(alias)).toString()).toBe("fresh");
  });

  it("serializes the real secret CLI against the MCP store across processes", async () => {
    const store = await storeFixture();
    const alias = "cross-process";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    async function* slowSecret() {
      markStarted();
      yield Buffer.from("server-");
      await release;
      yield Buffer.from("value");
    }
    const first = store.putChunks(alias, slowSecret());
    await started;

    const cliValue = path.join(store.root, ".cli-value");
    await writeFile(cliValue, "cli-value");
    const child = spawn(process.execPath, ["deploy/secrets/rcmcp-secret.ts", "put", alias, "--file", cliValue], {
      cwd: path.resolve("."),
      env: { ...process.env, RCMCP_SECRET_DIR: store.root },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let childExited = false;
    const childResultPromise = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => { childExited = true; resolve({ code, stdout, stderr }); });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(childExited).toBe(false);

    releaseFirst();
    await first;
    const childResult = await childResultPromise;
    expect(childResult.code, childResult.stderr).toBe(0);
    expect((await store.read(alias)).toString()).toBe("cli-value");
    expect((await readdir(store.root)).filter((name) => name.startsWith(".lock-"))).toEqual([]);
  });

  it("syncs broker-root membership when aliases are created or removed", async () => {
    const source = await readFile(path.resolve("apps/mcp-server/src/secret-store.ts"), "utf8");
    expect(source).toContain("if (!entryExisted) await syncDirectory(this.root)");
    expect(source).toContain("await syncDirectory(this.root)");
    const store = await storeFixture();
    await store.put("membership", Buffer.from("value"));
    await expect(store.delete("membership")).resolves.toEqual({ alias: "membership", deleted: true });
    await expect(store.metadata("membership")).resolves.toEqual({ alias: "membership", present: false });
  });

  it("cleans complete staging if transaction journal creation fails before activation", async () => {
    const store = await storeFixture();
    const original = (store as any).writeTransaction.bind(store);
    (store as any).writeTransaction = async () => { throw new Error("journal failed before activation"); };
    await expect(store.put("journal-fail", Buffer.from("secret"))).rejects.toThrow("journal failed before activation");
    (store as any).writeTransaction = original;
    const dirs = await readdir(store.root, { withFileTypes: true });
    for (const dir of dirs.filter((item) => item.isDirectory())) {
      const names = await readdir(path.join(store.root, dir.name));
      expect(names.filter((name) => name.includes(".tmp") || name.includes(".bak") || name === "replace.json")).toEqual([]);
    }
    await expect(store.metadata("journal-fail")).resolves.toEqual({ alias: "journal-fail", present: false });
  });

  it("recovers staged data if journal activation succeeds but durability reporting fails", async () => {
    const store = await storeFixture();
    const original = (store as any).writeTransaction.bind(store);
    (store as any).writeTransaction = async (...args: unknown[]) => {
      await original(...args);
      throw new Error("journal post-activation sync failed");
    };
    await expect(store.put("journal-post-activation", Buffer.from("secret"))).rejects.toThrow("journal post-activation sync failed");
    (store as any).writeTransaction = original;
    await expect(store.metadata("journal-post-activation")).resolves.toEqual({ alias: "journal-post-activation", present: false });
    const dirs = await readdir(store.root, { withFileTypes: true });
    for (const dir of dirs.filter((item) => item.isDirectory())) {
      const names = await readdir(path.join(store.root, dir.name));
      expect(names.filter((name) => name.includes(".tmp") || name.includes(".bak") || name === "replace.json")).toEqual([]);
    }
  });

  it("rolls back an interrupted secret replacement on the next access", async () => {
    const store = await storeFixture();
    const alias = "recover-rollback";
    await store.put(alias, Buffer.from("old-secret"));
    const [entryDirName] = (await readdir(store.root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
    if (!entryDirName) throw new Error("missing secret entry directory");
    const dir = path.join(store.root, entryDirName);
    const tempSecret = ".secret-crash.tmp";
    const tempMeta = ".meta-crash.tmp";
    const backupSecret = ".secret-crash.bak";
    const backupMeta = ".meta-crash.bak";
    await writeFile(path.join(dir, tempSecret), "new-secret");
    await writeFile(path.join(dir, tempMeta), JSON.stringify({ alias, bytes: 10, updatedAt: new Date().toISOString() }) + "\n");
    await writeFile(path.join(dir, "replace.json"), JSON.stringify({
      version: 1, alias, tempSecret, tempMeta, backupSecret, backupMeta, hadSecret: true, hadMeta: true,
    }) + "\n");
    await rename(path.join(dir, "secret"), path.join(dir, backupSecret));
    await rename(path.join(dir, "meta.json"), path.join(dir, backupMeta));
    await rename(path.join(dir, tempSecret), path.join(dir, "secret"));

    expect((await store.read(alias)).toString()).toBe("old-secret");
    const names = await readdir(dir);
    expect(names.sort()).toEqual(["meta.json", "secret"]);
    expect(JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")).alias).toBe(alias);
  });

  it("finishes cleanup after a fully activated secret replacement crashes before journal removal", async () => {
    const store = await storeFixture();
    const alias = "recover-commit";
    await store.put(alias, Buffer.from("old-secret"));
    const [entryDirName] = (await readdir(store.root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name);
    if (!entryDirName) throw new Error("missing secret entry directory");
    const dir = path.join(store.root, entryDirName);
    const tempSecret = ".secret-commit.tmp";
    const tempMeta = ".meta-commit.tmp";
    const backupSecret = ".secret-commit.bak";
    const backupMeta = ".meta-commit.bak";
    await writeFile(path.join(dir, tempSecret), "new-secret");
    await writeFile(path.join(dir, tempMeta), JSON.stringify({ alias, bytes: 10, updatedAt: new Date().toISOString() }) + "\n");
    await writeFile(path.join(dir, "replace.json"), JSON.stringify({
      version: 1, alias, tempSecret, tempMeta, backupSecret, backupMeta, hadSecret: true, hadMeta: true,
    }) + "\n");
    await rename(path.join(dir, "secret"), path.join(dir, backupSecret));
    await rename(path.join(dir, "meta.json"), path.join(dir, backupMeta));
    await rename(path.join(dir, tempSecret), path.join(dir, "secret"));
    await rename(path.join(dir, tempMeta), path.join(dir, "meta.json"));

    expect((await store.read(alias)).toString()).toBe("new-secret");
    expect((await readdir(dir)).sort()).toEqual(["meta.json", "secret"]);
  });

  it("installs an alias with restrictive staging permissions and truthful atomicity", async () => {
    const store = await storeFixture();
    const marker = "SECRET-INTERNAL-ONLY";
    await store.put("api", Buffer.from(marker));
    const { client, files, writes } = memoryClient({}, false);
    const result = await installSecret(client, store, { alias: "api", device: "pc", destination: "/opt/app/.env", identity: "root" });
    expect(files.get("/opt/app/.env")?.toString()).toBe(marker);
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(writes[0]).toMatchObject({ permissions: 0o600, mode: "rewrite" });
    expect(result).toMatchObject({ alias: "api", device: "pc", destination: "/opt/app/.env", bytes: marker.length, identity: "root", atomic: false, destinationAtomic: false });
  });

  it("imports a remote file into an alias without surfacing content", async () => {
    const store = await storeFixture();
    const marker = Buffer.from("REMOTE-PRIVATE-BYTES");
    const { client } = memoryClient({ "/source/key.bin": marker });
    const result = await importRemoteSecret(client, store, { alias: "imported", sourceDevice: "pc", sourcePath: "/source/key.bin", sourceIdentity: "owner" });
    expect((await store.read("imported")).equals(marker)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker.toString());
    expect(result).toMatchObject({ alias: "imported", present: true, bytes: marker.length, importedFrom: { device: "pc", identity: "owner" } });
  });

  it("renders text and base64 aliases internally into a remote template", async () => {
    const store = await storeFixture();
    await store.put("token", Buffer.from("PRIVATE-TOKEN"));
    const { client, files } = memoryClient();
    const result = await renderSecretTemplate(client, store, {
      device: "pc", destination: "/opt/app/.env", identity: "root", template: "TOKEN={{secret:token}}\nB64={{secret_base64:token}}\n",
    });
    expect(files.get("/opt/app/.env")?.toString()).toContain("TOKEN=PRIVATE-TOKEN");
    expect(JSON.stringify(result)).not.toContain("PRIVATE-TOKEN");
    expect(result.aliases).toEqual(["token"]);
  });

  it("does not reinterpret placeholders inserted from secret text", async () => {
    const store = await storeFixture();
    await store.put("a", Buffer.from("literal={{secret:b}}"));
    await store.put("b", Buffer.from("SECOND"));
    const { client, files } = memoryClient();
    await renderSecretTemplate(client, store, {
      device: "pc", destination: "/opt/app/template.env", template: "A={{secret:a}}\nB={{secret:b}}\n",
    });
    expect(files.get("/opt/app/template.env")?.toString()).toBe("A=literal={{secret:b}}\nB=SECOND\n");
  });

  it("renders a base64-only placeholder for arbitrary binary bytes without UTF-8 decoding", async () => {
    const store = await storeFixture();
    const binary = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x80]);
    await store.put("binary", binary);
    const { client, files } = memoryClient();
    await renderSecretTemplate(client, store, { device: "pc", destination: "/opt/app/binary.env", template: "VALUE={{secret_base64:binary}}" });
    expect(files.get("/opt/app/binary.env")?.toString()).toBe(`VALUE=${binary.toString("base64")}`);
  });
});
