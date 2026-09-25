import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import * as fsPromises from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as atomic from "../apps/agent/src/filesystem-atomic.ts";
import { fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";
import { openRawFile, receiveDirectTransfer } from "../apps/agent/src/direct-transfer.ts";
import { beginTransfer, finalizeTransfer } from "../apps/agent/src/transfer-staging.ts";
import { transferFile, syncDirectory } from "../apps/mcp-server/src/transfer-tools.ts";
import { fsManageSchema } from "../packages/protocol/src/filesystem.ts";

vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const execute = promisify(execFile);
// Native directory-symlink fixtures require actual OS permission. Missing
// Developer Mode/elevation means skipped qualification, never a passed test.
const hasDirectorySymlinkPrivilege = process.platform !== "win32" || (() => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-symlink-privilege-"));
  try {
    mkdirSync(path.join(root, "target"));
    symlinkSync("target", path.join(root, "link"), "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally { rmSync(root, { recursive: true, force: true }); }
})();
// AUTO_INHERITED is bookkeeping, not permission/protection or an ACE flag.
const semanticSddl = (value: string) => value.replace(/(D:P?)AI(?=\(|S:|$)/g, "$1");
const hasPosixAclTools = process.platform === "linux" && (() => {
  try { execFileSync("setfacl", ["--version"], { stdio: "ignore" }); execFileSync("getfacl", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();
const otherGid = process.getgroups?.().find(gid => gid !== process.getgid?.());
const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-audit39-")); roots.push(root);
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  await writeFile(source, Buffer.alloc(150_001, 0x61));
  return { root, source, destination };
}
function client(onWrite?: (pathname: string) => Promise<void>) {
  return {
    info: async () => ({ platform: process.platform, runtime: { transferStagingVersion: 1 } }),
    fsManage: async (_device: string, input: Parameters<typeof fsManage>[0]) => fsManage(fsManageSchema.parse(input)),
    fsRead: async (_device: string, input: Parameters<typeof fsRead>[0]) => fsRead(input),
    fsWrite: async (_device: string, input: Parameters<typeof fsWrite>[0]) => {
      const result = await fsWrite(input); await onWrite?.(input.path); return result;
    },
  };
}
async function transfer(transport: string, source: string, destination: string, onWrite?: (pathname: string) => Promise<void>) {
  if (transport === "relay") return transferFile(client(onWrite) as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, chunkBytes: 65536 });
  const server = createServer(async (req, res) => {
    try {
      const raw = await openRawFile(source, { metadataOnly: req.method === "HEAD" });
      res.setHeader("content-length", raw.size); res.setHeader("x-rcmcp-modified-at", raw.modifiedAt);
      res.setHeader("x-rcmcp-sha256", raw.sha256); res.setHeader("x-rcmcp-source-confirmation", "head");
      if (raw.posixMode !== undefined) res.setHeader("x-rcmcp-posix-mode", raw.posixMode);
      if (req.method === "HEAD") res.end(); else { await onWrite?.(""); raw.stream.pipe(res); }
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return receiveDirectTransfer({ sourceBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sourcePath: source, destinationPath: destination });
}

for (const transport of ["direct", "relay"]) {
  it.skipIf(process.platform === "win32").each([0o600, 0o640, 0o664, 0o755, 0o775])(`${transport} preserves source mode %i for new files under umask 0002`, async mode => {
    const { root, source, destination } = await fixture(); await chmod(source, mode);
    const oldUmask = process.umask(0o002);
    try { await transfer(transport, source, destination); } finally { process.umask(oldUmask); }
    expect((await stat(destination)).mode & 0o7777).toBe(mode);
    expect(await readFile(destination)).toEqual(await readFile(source));
    expect(await readdir(root)).toEqual(["destination", "source"]);
  });
  it.skipIf(process.platform === "win32").each([0o600, 0o640, 0o755])(`${transport} retains existing mode %i and same-host ownership`, async mode => {
    const { source, destination } = await fixture(); await chmod(source, 0o777);
    await writeFile(destination, "old"); await chmod(destination, mode);
    const before = await stat(destination);
    await transfer(transport, source, destination);
    const after = await stat(destination);
    expect(after.mode & 0o7777).toBe(mode); expect(after.uid).toBe(before.uid); expect(after.gid).toBe(before.gid);
    expect(await readFile(destination)).toEqual(await readFile(source));
  });
  it.skipIf(process.platform === "win32" || otherGid === undefined)(`${transport} retains a different destination group and never imports the source group`, async () => {
    const { source, destination } = await fixture(); await writeFile(destination, "old");
    await chown(destination, process.getuid!(), otherGid!);
    await transfer(transport, source, destination);
    expect((await stat(destination)).gid).toBe(otherGid);
    await rm(destination);
    await chown(source, process.getuid!(), otherGid!);
    await transfer(transport, source, destination);
    expect((await stat(destination)).gid).toBe(process.getgid!());
  });
  it.skipIf(!hasPosixAclTools)(`${transport} preserves the destination POSIX ACL`, async () => {
    const { source, destination } = await fixture(); await writeFile(destination, "old");
    // Local fixture ACL only. Numeric nobody SID is not imported from source.
    await execute("setfacl", ["-m", "u:65534:r--", destination]);
    const acl = async () => (await execute("getfacl", ["-c", "-n", destination])).stdout;
    const before = await acl(); await transfer(transport, source, destination);
    expect(await acl()).toBe(before);
  });
  it.skipIf(process.platform !== "win32").each([false, true])(`${transport} preserves native Windows destination DACL/owner and ADS (protected=%s)`, async protectedAcl => {
    const { source, destination } = await fixture(); await writeFile(destination, "old");
    const ps = (script: string) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script], { env: { ...process.env, TEST_DEST: destination } });
    await ps(`$p=$env:TEST_DEST;$a=Get-Acl -LiteralPath $p;$a.SetAccessRuleProtection($${protectedAcl ? "true" : "false"},$true);Set-Acl -LiteralPath $p -AclObject $a;Set-Content -LiteralPath $p -Stream audit -Value 'retained'`);
    const before = (await ps('(Get-Acl -LiteralPath $env:TEST_DEST).Sddl')).stdout.trim();
    const result = await transfer(transport, source, destination);
    expect(result).toMatchObject({ metadataPreserved: true, metadataStrategy: "windows-full", atomic: true });
    expect(semanticSddl((await ps('(Get-Acl -LiteralPath $env:TEST_DEST).Sddl')).stdout.trim())).toBe(semanticSddl(before));
    expect((await ps('Get-Content -LiteralPath $env:TEST_DEST -Stream audit')).stdout.trim()).toBe("retained");
    expect(await readFile(destination)).toEqual(await readFile(source));
  }, 60000);
}

it.skipIf(process.platform === "win32")("relay keeps all chunks in private staging and strips only source special bits", async () => {
  const { source, destination } = await fixture(); await chmod(source, 0o6777);
  let chunks = 0;
  await transfer("relay", source, destination, async temporary => {
    chunks++;
    expect((await stat(temporary)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(temporary))).mode & 0o777).toBe(0o700);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
  expect(chunks).toBe(3); expect((await stat(destination)).mode & 0o7777).toBe(0o777);
});

it.skipIf(process.platform !== "win32")("Windows staging excludes inherited access before any payload write", async () => {
  const { destination } = await fixture(); const stage = await beginTransfer(destination);
  const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$a=Get-Acl -LiteralPath $env:TEST_STAGE;$a.AreAccessRulesProtected; $a.Access | ForEach-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value}; [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`], { env: { ...process.env, TEST_STAGE: stage.directory } });
  const lines = stdout.trim().split(/\r?\n/); expect(lines[0]).toBe("True"); expect(lines.slice(1, -1)).toEqual([lines.at(-1)]);
}, 30000);

it.each(["direct", "relay"])("rejects a destination changed while %s data is in flight", async transport => {
  const { source, destination } = await fixture(); await writeFile(destination, "old");
  await expect(transfer(transport, source, destination, async () => { await writeFile(destination, "concurrent"); })).rejects.toThrow(/Destination changed/);
  expect(await readFile(destination, "utf8")).toBe("concurrent");
});

it("rejects metadata changes during cloning and does not publish after cancellation", async () => {
  const { destination } = await fixture(); await writeFile(destination, "old");
  const stage = await beginTransfer(destination); await writeFile(stage.temporaryPath, "new");
  const original = atomic.cloneExistingMetadata;
  vi.spyOn(atomic, "cloneExistingMetadata").mockImplementation(async (...args) => {
    const result = await original(...args); await writeFile(destination, "concurrent"); return result;
  });
  await expect(finalizeTransfer({ path: stage.temporaryPath, destination, expectedDestination: stage.expectedDestination, expectedBytes: 3 })).rejects.toThrow(/Destination changed/);
  expect(await readFile(destination, "utf8")).toBe("concurrent");
  const aborted = new AbortController(); aborted.abort();
  await expect(finalizeTransfer({ path: stage.temporaryPath, destination, expectedDestination: stage.expectedDestination, expectedBytes: 3 }, aborted.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("fails without overwriting when destination metadata cannot be cloned", async () => {
  const { destination } = await fixture(); await writeFile(destination, "old");
  const stage = await beginTransfer(destination); await writeFile(stage.temporaryPath, "new");
  vi.spyOn(atomic, "cloneExistingMetadata").mockResolvedValue("none");
  await expect(finalizeTransfer({ path: stage.temporaryPath, destination, expectedDestination: stage.expectedDestination, expectedBytes: 3 })).rejects.toThrow(/preserve destination metadata/);
  expect(await readFile(destination, "utf8")).toBe("old");
});

it("requires finalization metadata in the agent protocol and rejects unsafe source mode fields", () => {
  expect(fsManageSchema.safeParse({ operation: "transfer-finalize", path: "payload" }).success).toBe(false);
  expect(fsManageSchema.safeParse({ operation: "transfer-finalize", path: "payload", destination: "dest", expectedBytes: 1, expectedDestination: "absent", sourceMode: 0o6755 }).success).toBe(false);
  expect(fsManageSchema.safeParse({ operation: "copy", path: "source", destination: "dest", force: false }).success).toBe(true);
});

it("reports no-clobber copy as skipped/destination_exists with unchanged content", async () => {
  const { source, destination } = await fixture(); await writeFile(destination, "old");
  const result = await fsManage({ operation: "copy", path: source, destination, force: false });
  expect(result).toMatchObject({ ok: true, outcome: "skipped", copied: 0, skipped: 1, reason: "destination_exists" });
  expect(await readFile(destination, "utf8")).toBe("old");
});

it("reports recursive copied/skipped counts without forcing existing files", async () => {
  const { root } = await fixture(); const source = path.join(root, "tree"), destination = path.join(root, "out");
  await mkdir(source); await mkdir(destination); await mkdir(path.join(source, "nested")); await mkdir(path.join(destination, "nested"));
  await writeFile(path.join(source, "nested", "exists"), "new"); await writeFile(path.join(destination, "nested", "exists"), "old");
  await writeFile(path.join(source, "fresh"), "fresh");
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ ok: true, outcome: "partial", copied: 1, skipped: 1, reason: "destination_exists" });
  expect(await readFile(path.join(destination, "nested", "exists"), "utf8")).toBe("old");
  expect(await readFile(path.join(destination, "fresh"), "utf8")).toBe("fresh");
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ outcome: "skipped", copied: 0, skipped: 2 });
});

it.skipIf(process.platform === "win32")("no-clobber copy preserves existing symlinks and never follows destination directory symlinks", async () => {
  const { root, source, destination } = await fixture(); const target = path.join(root, "target"); await writeFile(target, "keep");
  await symlink(target, destination);
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ copied: 0, skipped: 1 });
  expect(await readFile(target, "utf8")).toBe("keep"); expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  const tree = path.join(root, "tree"), outside = path.join(root, "outside"); await mkdir(tree); await mkdir(outside); await writeFile(path.join(tree, "file"), "new");
  const alias = path.join(root, "alias"); await symlink(outside, alias);
  expect(await fsManage({ operation: "copy", path: tree, destination: alias, force: false })).toMatchObject({ outcome: "skipped", skipped: 1, copied: 0 });
  expect(await readdir(outside)).toEqual([]);
});


it("no-clobber copy reports a destination created at the actual copy boundary", async () => {
  const { source, destination } = await fixture();
  const copy = fsPromises.copyFile;
  vi.spyOn(fsPromises, "copyFile").mockImplementation(async (from, to, flags) => {
    await writeFile(to, "concurrent"); return copy(from, to, flags);
  });
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ outcome: "skipped", copied: 0, skipped: 1, reason: "destination_exists" });
  expect(await readFile(destination, "utf8")).toBe("concurrent");
});

it("reports an existing empty directory as skipped and partial copy failure explicitly", async () => {
  const { root } = await fixture(); const source = path.join(root, "tree"), destination = path.join(root, "out");
  await mkdir(source); await mkdir(destination);
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ outcome: "skipped", copied: 0, skipped: 1 });
  await writeFile(path.join(source, "a"), "copied"); await writeFile(path.join(source, "b"), "failed");
  const copy = fsPromises.copyFile;
  vi.spyOn(fsPromises, "copyFile").mockImplementation(async (from, to, flags) => {
    if (String(from).endsWith(path.sep + "b")) throw new Error("fixture I/O failure");
    return copy(from, to, flags);
  });
  expect(await fsManage({ operation: "copy", path: source, destination, force: false })).toMatchObject({ ok: false, outcome: "failed", copied: 1, skipped: 0, partialEffectsPossible: true, error: "fixture I/O failure" });
  expect(await readFile(path.join(destination, "a"), "utf8")).toBe("copied");
});


it("validates additive copy semantic result fields while accepting legacy agents", () => {
  const base = { operation: "copy", path: "source", ok: true };
  expect(toolResultSchemas.fs_manage.safeParse(base).success).toBe(true);
  expect(toolResultSchemas.fs_manage.safeParse({ ...base, copied: 1, skipped: 1, outcome: "partial", reason: "destination_exists" }).success).toBe(true);
  expect(toolResultSchemas.fs_manage.safeParse({ ...base, skipped: -1 }).success).toBe(false);
  expect(toolResultSchemas.fs_manage.safeParse({ ...base, outcome: "success" }).success).toBe(false);
});


it("retains cp self/descendant checks for dot paths before any destination mutation", async () => {
  const { root } = await fixture();
  const source = path.join(root, "tree"); await mkdir(source); await writeFile(path.join(source, "file"), "keep");
  await expect(fsManage({ operation: "copy", path: source + path.sep + ".", destination: path.join(source, "nested"), force: false })).rejects.toThrow(/itself/);
  expect(await readdir(source)).toEqual(["file"]);
  const destination = path.join(root, "copied");
  expect(await fsManage({ operation: "copy", path: source + path.sep + ".", destination, force: false })).toMatchObject({ outcome: "copied", copied: 2, skipped: 0 });
  expect(await readFile(path.join(destination, "file"), "utf8")).toBe("keep");
});


it.skipIf(process.platform === "win32").each(["direct", "relay"])("rejects a source made private during %s transfer", async transport => {
  const { source, destination } = await fixture(); await chmod(source, 0o755); await writeFile(destination, "old");
  await expect(transfer(transport, source, destination, async () => { await chmod(source, 0o600); })).rejects.toThrow(/Source changed/);
  expect(await readFile(destination, "utf8")).toBe("old");
});


it.skipIf(process.platform === "win32")("preserves relative symlink targets when a copied tree is relocated", async () => {
  const { root } = await fixture(); const source = path.join(root, "tree"), destination = path.join(root, "copied");
  await mkdir(source); await writeFile(path.join(source, "target"), "content"); await symlink("target", path.join(source, "link"));
  const result=await fsManage({operation:"copy",path:source,destination,force:false}); expect(result.ok).toBe(true);
  expect(await fsPromises.readlink(path.join(destination,"link"))).toBe("target");
  const moved=path.join(root,"relocated"); await fsPromises.rename(destination,moved);
  expect(await readFile(path.join(moved,"link"),"utf8")).toBe("content");
});
it.skipIf(process.platform === "win32")("restores newly copied directory permissions despite a restrictive umask", async () => {
  const { root }=await fixture(); const source=path.join(root,"tree"), destination=path.join(root,"copied");
  await mkdir(source); await chmod(source,0o775); await writeFile(path.join(source,"child"),"content");
  const previous=process.umask(0o077);
  try{expect((await fsManage({operation:"copy",path:source,destination,force:false})).ok).toBe(true)}finally{process.umask(previous)}
  expect((await stat(destination)).mode&0o777).toBe(0o775);
  expect(await readFile(path.join(destination,"child"),"utf8")).toBe("content");
});
it("counts a copied file even when subsequent timestamp restoration fails", async () => {
  const {source,destination}=await fixture();
  vi.spyOn(fsPromises,"utimes").mockRejectedValueOnce(Object.assign(new Error("fixture timestamp failure"),{code:"EIO"}));
  const result=await fsManage({operation:"copy",path:source,destination,force:false});
  expect(result).toMatchObject({ok:false,outcome:"failed",copied:1,skipped:0,partialEffectsPossible:true});
  expect(await readFile(destination)).toEqual(await readFile(source));
});


it.each(["utimes","chmod"] as const)("counts forced-copy bytes when subsequent %s fails", async method => {
  const {source,destination}=await fixture();await writeFile(destination,"old");
  vi.spyOn(fsPromises,method).mockRejectedValueOnce(Object.assign(new Error("fixture metadata failure"),{code:"EIO"}));
  const result=await fsManage({operation:"copy",path:source,destination,force:true});
  expect(result).toMatchObject({ok:false,outcome:"failed",copied:1,skipped:0,partialEffectsPossible:true});
  expect(await readFile(destination)).toEqual(await readFile(source));
});
it.skipIf(process.platform !== "win32" || !hasDirectorySymlinkPrivilege).each([false,true])("preserves native Windows directory symlink kind before target copy (force=%s, requires symlink privilege)", async force => {
  const {root}=await fixture();const source=path.join(root,"tree"),destination=path.join(root,"copy");
  await mkdir(source);await mkdir(path.join(source,"z-target"));await writeFile(path.join(source,"z-target","child"),"linked");
  await symlink("z-target",path.join(source,"a-link"),"dir");
  const result=await fsManage({operation:"copy",path:source,destination,force});expect(result.ok).toBe(true);
  expect(await fsPromises.readlink(path.join(destination,"a-link"))).toBe("z-target");
  expect(await readFile(path.join(destination,"a-link","child"),"utf8")).toBe("linked");
  expect((await stat(path.join(destination,"a-link"))).isDirectory()).toBe(true);
},30000);
it.skipIf(process.platform === "win32")("forced regular copy replaces destination symlink without changing its target",async()=>{
  const {root,source,destination}=await fixture();const outside=path.join(root,"outside");await writeFile(outside,"keep");await symlink(outside,destination);
  const result=await fsManage({operation:"copy",path:source,destination,force:true});expect(result).toMatchObject({ok:true,copied:1});
  expect(await readFile(outside,"utf8")).toBe("keep");expect((await lstat(destination)).isSymbolicLink()).toBe(false);
});


it.each(["direct","relay"])("reports successful publication with pending %s private-stage cleanup", async transport => {
  const {root,source,destination}=await fixture();
  const realRm=fsPromises.rm;
  vi.spyOn(fsPromises,"rm").mockImplementation(async(target,options)=>{
    if(path.dirname(String(target))===root && String(target)!==destination && String(target)!==source) throw Object.assign(new Error("fixture stage cleanup denied"),{code:"EACCES"});
    return realRm(target,options);
  });
  const result=await transfer(transport,source,destination);
  expect(result).toMatchObject({ok:true,cleanupPending:true,cleanupError:expect.stringContaining("fixture stage cleanup denied")});
  if (!("cleanupPath" in result)) throw new Error("Missing cleanupPath");
  expect(result.cleanupPath).toBeTruthy();expect(await stat(result.cleanupPath!)).toBeTruthy();
  expect(await readFile(destination)).toEqual(await readFile(source));
});
it.skipIf(process.platform === "win32")("reports retained linked payload until private-directory cleanup succeeds",async()=>{
  const {source,destination}=await fixture();const stage=await beginTransfer(destination);await writeFile(stage.temporaryPath,await readFile(source));
  vi.spyOn(fsPromises,"unlink").mockRejectedValueOnce(Object.assign(new Error("fixture unlink denied"),{code:"EACCES"}));
  const result=await finalizeTransfer({path:stage.temporaryPath,destination,expectedDestination:stage.expectedDestination,expectedBytes:(await stat(source)).size,sourceMode:0o600});
  expect(result).toMatchObject({ok:true,cleanupPending:true,cleanupPath:stage.temporaryPath});
  expect(await readFile(destination)).toEqual(await readFile(stage.temporaryPath));
});
it("negotiates old agents before creating a directory tree and keeps legacy behavior explicit",async()=>{
  const {root,source}=await fixture();const sourceDir=path.join(root,"source-tree"),destinationDir=path.join(root,"destination-tree");
  await mkdir(sourceDir);await writeFile(path.join(sourceDir,"file"),"content");
  const base=client();let mutations=0;
  const old={...base,info:async()=>({platform:process.platform}),fsList:async(_device:string,input:{path:string})=>{
    const entries=await readdir(input.path,{withFileTypes:true});return Promise.all(entries.map(async item=>({name:item.name,path:path.join(input.path,item.name),type:item.isDirectory()?"directory":"file",size:(await stat(path.join(input.path,item.name))).size})))
  },fsManage:async(device:string,input:any)=>{
    if(!["stat","times","mkdir","move","copy","delete"].includes(input.operation))throw new Error("legacy invalid operation");
    if(input.operation!=="stat")mutations++;
    return base.fsManage(device,input);
  }};
  await expect(syncDirectory(old as any,{sourceDevice:"a",sourcePath:sourceDir,destinationDevice:"b",destinationPath:destinationDir})).rejects.toThrow("allowLegacyAgent=true");
  expect(mutations).toBe(0);await expect(stat(destinationDir)).rejects.toMatchObject({code:"ENOENT"});
  const fileDestination=path.join(root,"legacy-file");
  await expect(transferFile(old as any,{sourceDevice:"a",sourcePath:source,destinationDevice:"b",destinationPath:fileDestination})).rejects.toThrow("No destination mutation");
  expect(mutations).toBe(0);
  const result=await transferFile(old as any,{sourceDevice:"a",sourcePath:source,destinationDevice:"b",destinationPath:fileDestination,allowLegacyAgent:true});
  expect(result).toMatchObject({legacyAgent:true,metadataPreserved:false,compatibilityWarning:expect.stringContaining("not guaranteed")});
  expect(await readFile(fileDestination)).toEqual(await readFile(source));
  const sync=await syncDirectory(old as any,{sourceDevice:"a",sourcePath:sourceDir,destinationDevice:"b",destinationPath:destinationDir,allowLegacyAgent:true});
  expect(sync).toMatchObject({legacyAgent:true,metadataPreserved:false,filesTransferred:1});expect(await readFile(path.join(destinationDir,"file"),"utf8")).toBe("content");
});


it("reports an unconfirmed relay cleanup within its separate bounded cleanup budget",async()=>{
  const {source,destination}=await fixture();const base=client();
  let cleanupStarted: number | undefined;
  const stalled={...base,fsManage:async(device:string,input:any)=> {
    if(input.operation!=="delete") return base.fsManage(device,input);
    // Native staging/ACL work belongs to the transfer, not its cleanup budget.
    cleanupStarted=performance.now();
    return new Promise(()=>{});
  }};
  const result=await transferFile(stalled as any,{sourceDevice:"a",sourcePath:source,destinationDevice:"b",destinationPath:destination});
  expect(result).toMatchObject({ok:true,cleanupPending:true,cleanupError:expect.stringContaining("250ms")});
  expect(cleanupStarted).toBeDefined();
  expect(performance.now()-cleanupStarted!).toBeLessThan(2000);
  expect(await readFile(destination)).toEqual(await readFile(source));
});

it.each(["direct", "relay"])("negotiates a legacy source before %s mutation and reports explicit compatibility", async transport => {
  const { source, destination } = await fixture();
  const base = client();
  const server = createServer(async (req, res) => {
    try {
      const raw = await openRawFile(source, { metadataOnly: req.method === "HEAD" });
      res.setHeader("content-length", raw.size);
      res.setHeader("x-rcmcp-modified-at", raw.modifiedAt);
      res.setHeader("x-rcmcp-sha256", raw.sha256);
      res.setHeader("x-rcmcp-source-confirmation", "head");
      // An old source does not publish x-rcmcp-posix-mode.
      if (req.method === "HEAD") res.end(); else raw.stream.pipe(res);
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const sourceBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let mutations = 0;
  const mixed = {
    ...base,
    info: vi.fn(async (device: string) => device === "a" ? { platform: process.platform } : base.info()),
    fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
      if (device === "b" && input.operation !== "stat") mutations++;
      const result = await base.fsManage(device, input);
      if (device === "a" && input.operation === "stat") {
        const legacy = { ...result } as Record<string, unknown>; delete legacy.posixMode; return legacy;
      }
      return result;
    },
    directTransfer: vi.fn(async (_source: string, _destination: string, input: any) => receiveDirectTransfer({ ...input, sourceBase })),
  };
  const input = { sourceDevice: "a", sourcePath: source, sourceContext: "user" as const,
    destinationDevice: "b", destinationPath: destination, transport: transport as "direct" | "relay" };
  await expect(transferFile(mixed as any, input)).rejects.toThrow(/Source agent.*allowLegacyAgent=true/);
  expect(mutations).toBe(0); expect(mixed.directTransfer).not.toHaveBeenCalled();
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const result = await transferFile(mixed as any, { ...input, allowLegacyAgent: true });
  expect(result).toMatchObject({ legacyAgent: true, metadataPreserved: false, compatibilityWarning: expect.stringContaining("not guaranteed") });
  expect(await readFile(destination)).toEqual(await readFile(source));
  expect(mixed.info).toHaveBeenCalledWith("a", "user", expect.any(Object));
});

it.each(["direct", "relay"])("rejects an old directory source before any %s destination creation", async transport => {
  const { root } = await fixture();
  const source = path.join(root, "source-tree"), destination = path.join(root, "destination-tree");
  await mkdir(source); await writeFile(path.join(source, "file"), "content");
  const base = client(); let mutations = 0;
  const mixed = {
    ...base,
    info: async (device: string) => device === "a" ? { platform: process.platform } : base.info(),
    fsList: async (_device: string, input: { path: string }) => [{ name: "file", path: path.join(input.path, "file"), type: "file", size: 7 }],
    fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
      if (device === "b" && input.operation !== "stat") mutations++;
      return base.fsManage(device, input);
    },
    directTransfer: vi.fn(),
  };
  await expect(syncDirectory(mixed as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, transport: transport as "direct" | "relay" })).rejects.toThrow(/Source agent.*allowLegacyAgent=true/);
  expect(mutations).toBe(0); expect(mixed.directTransfer).not.toHaveBeenCalled();
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

for (const legacyDevice of ["a", "b"]) {
  it.each(["empty", "nested", "skipped"])(`negotiates legacy ${legacyDevice} for a %s directory tree without regular files`, async shape => {
    const { root } = await fixture();
    const source = path.join(root, "source-tree"), destination = path.join(root, "destination-tree");
    await mkdir(source); if (shape === "nested") await mkdir(path.join(source, "nested"));
    const base = client(); let mutations = 0;
    const mixed = {
      ...base,
      info: async (device: string) => device === legacyDevice ? { platform: process.platform } : base.info(),
      fsList: async (_device: string, input: { path: string }) => {
        if (shape === "skipped") return [{ name: "special", path: path.join(input.path, "special"), type: "other", size: 0 }];
        const entries = await readdir(input.path, { withFileTypes: true });
        return entries.map(entry => ({ name: entry.name, path: path.join(input.path, entry.name), type: "directory", size: 0 }));
      },
      fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
        if (device === "b" && input.operation !== "stat") mutations++;
        return base.fsManage(device, input);
      },
    };
    const input = { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination };
    await expect(syncDirectory(mixed as any, input)).rejects.toThrow(/agent lacks.*allowLegacyAgent=true/);
    expect(mutations).toBe(0); await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await syncDirectory(mixed as any, { ...input, allowLegacyAgent: true });
    expect(result).toMatchObject({ files: 0, filesTransferred: 0, legacyAgent: true, metadataPreserved: false, compatibilityWarning: expect.stringContaining("not guaranteed") });
    expect((await stat(destination)).isDirectory()).toBe(true);
  });
}

for (const cleanup of ["failed", "timeout"]) {
  it.each(["abort", "frozen"])(`preserves a %s error when relay cleanup ${cleanup}`, async kind => {
    const { source, destination } = await fixture(); const base = client();
    const original = kind === "abort" ? new DOMException("fixture caller aborted", "AbortError") : Object.freeze(new Error("fixture frozen error"));
    const failing = {
      ...base,
      fsRead: async () => { throw original; },
      fsManage: async (device: string, input: Parameters<typeof fsManage>[0]) => {
        if (input.operation === "delete") {
          if (cleanup === "timeout") return new Promise<never>(() => {});
          throw new Error("fixture cleanup denied");
        }
        return base.fsManage(device, input);
      },
    };
    const error = await transferFile(failing as any, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination }).catch(error => error);
    expect(error).toMatchObject({ name: original.name, cause: original, cleanupPending: true, cleanupPath: expect.any(String), cleanupError: expect.any(String) });
    expect(error.message).toContain(original.message); expect(error.message).toContain("cleanup pending");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
}


it.skipIf(process.platform !== "win32").each(["direct", "relay"])("replaces a previously private %s transfer without importing parent ACEs", async transport => {
  const { source, destination } = await fixture();
  await transfer(transport, source, destination);
  const acl = async () => (await execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "(Get-Acl -LiteralPath $env:TEST_DEST).Sddl"], { env: { ...process.env, TEST_DEST: destination } })).stdout.trim();
  const before = await acl();
  await writeFile(source, "changed-content");
  const result = await transfer(transport, source, destination);
  expect(result).toMatchObject({ ok: true, metadataPreserved: true, metadataStrategy: "windows-full", atomic: true });
  expect(await readFile(destination, "utf8")).toBe("changed-content");
  expect(semanticSddl(await acl())).toBe(semanticSddl(before));
}, 60000);
