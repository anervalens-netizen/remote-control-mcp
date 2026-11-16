import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
const uids = [1_000_001, 1_000_002], gid = 1_000_003;
const nativeIdentities = process.platform === "linux" && process.getuid?.() === 0;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = `
import {ResourceCoordinator,coordinationFileMode,coordinationHash,coordinationToken,coordinationDevice,coordinationIdentity,ensureCoordinationDirectory} from ${JSON.stringify(new URL("../apps/agent/src/coordination.ts", import.meta.url).href)};
import {atomicWriteJson} from ${JSON.stringify(new URL("../apps/agent/src/state.ts", import.meta.url).href)};
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
const [root,mask,phase]=process.argv.slice(1);
process.umask(Number(mask));
try {
 const c=new ResourceCoordinator(root,4,Date.now,coordinationFileMode(process.env.RCMCP_COORDINATION_FILE_MODE));
 const resource={device:coordinationDevice,identity:coordinationIdentity,canonicalKey:coordinationHash('synthetic shared resource'),baseVersion:coordinationHash('synthetic base')};
 const previous=c.inspectRecovery(resource);
 if(phase==='inspect'){process.stdout.write(JSON.stringify(previous));}
 else {
  const record=c.acquire(resource),token=coordinationToken(record),id=randomUUID();c.begin(token,resource);
  const execution={kind:'repo_job',key:'synthetic:'+token.operationId,fingerprint:coordinationHash('input'),requestHash:coordinationHash('request')};
  c.bindExecution(token,execution);c.attachJob(token,id);
  const operationDir=ensureCoordinationDirectory(path.join(root,'repo-operations',token.operationId),c.fileMode);
  for(const name of ['request.json','result.json'])atomicWriteJson(path.join(operationDir,name),{synthetic:true},c.fileMode);
  c.reconcileJob(token,resource,resource.baseVersion,{id,device:resource.device,identity:resource.identity,state:'completed',containmentVerified:true,evidenceHash:coordinationHash('synthetic unit evidence'),key:execution.key,fingerprint:execution.fingerprint});
  const legacy={...resource,canonicalKey:coordinationHash('synthetic legacy '+coordinationIdentity)};
  const legacyToken=coordinationToken(c.acquire(legacy));c.begin(legacyToken,legacy);c.prepareRecovery(legacyToken,legacy,legacy.baseVersion);
  const directories=['executions','recovery-intents','reconciliations'].map(name=>{
   const dir=path.join(root,name),s=statSync(dir);
   const files=readdirSync(dir).map(file=>{const p=path.join(dir,file),s=statSync(p);JSON.parse(readFileSync(p,'utf8'));return {mode:s.mode&0o777,gid:s.gid};});
   return {name,mode:s.mode&0o7777,gid:s.gid,files};
  });
  const operationsRoot=path.join(root,'repo-operations'),operationRootStat=statSync(operationsRoot);
  const operations=readdirSync(operationsRoot).map(name=>{
   const dir=path.join(operationsRoot,name),s=statSync(dir);
   const files=['request.json','result.json'].map(name=>{const file=path.join(dir,name),s=statSync(file);JSON.parse(readFileSync(file,'utf8'));return {mode:s.mode&0o777,gid:s.gid};});
   return {mode:s.mode&0o7777,gid:s.gid,files};
  });
  process.stdout.write(JSON.stringify({previous,record,directories,operations,operationsRoot:{mode:operationRootStat.mode&0o7777,gid:operationRootStat.gid},identity:coordinationIdentity}));
 }
} catch(error){console.error(JSON.stringify({message:error.message,reason:error.reason,code:error.code}));process.exitCode=1;}
`;
function fixture(sharedIdentities = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-sharing-fixture-")); roots.push(root);
  if (sharedIdentities) chownSync(root, 0, gid);
  chmodSync(root, 0o2770);
  return root;
}
function run(root: string, mask: number, mode: string, phase = "create", uid?: number) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, root, String(mask), phase], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, RCMCP_STATE_DIR: path.join(root, "unused-state"), RCMCP_COORDINATION_FILE_MODE: mode },
    ...(uid === undefined ? {} : { uid, gid }),
  });
}
const directoryIdentity = (root: string) => { const s = statSync(root); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, ino: s.ino }; };

it.runIf(process.platform === "linux").each(["0600", "0660"])("new recovery directories honor %s through a restrictive umask without changing the provisioned root", mode => {
  const root = fixture(), before = directoryIdentity(root);
  const result = run(root, 0o077, mode);
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  for (const directory of output.directories) {
    expect(directory.mode).toBe(mode === "0660" ? 0o2770 : 0o2700);
    expect(directory.gid).toBe(before.gid);
    expect(directory.files.every((f: { mode: number; gid: number }) => f.mode === (mode === "0660" ? 0o660 : 0o600) && f.gid === before.gid)).toBe(true);
  }
  expect(output.operationsRoot).toEqual({ mode: mode === "0660" ? 0o2770 : 0o2700, gid: before.gid });
  expect(output.operations[0]).toMatchObject({ mode: mode === "0660" ? 0o2770 : 0o2700, gid: before.gid });
  expect(output.operations[0].files.every((f: { mode: number; gid: number }) => f.mode === (mode === "0660" ? 0o660 : 0o600) && f.gid === before.gid)).toBe(true);
  expect(directoryIdentity(root)).toEqual(before);
});

it.runIf(nativeIdentities).each([[0o077, 0o022], [0o022, 0o077]])("distinct Unix identities can inspect released recovery and create subsequent sidecars (umasks %s/%s)", (firstMask, secondMask) => {
  const root = fixture(true), before = directoryIdentity(root);
  const first = run(root, firstMask, "0660", "create", uids[0]);
  expect(first.status, first.stderr).toBe(0);
  const second = run(root, secondMask, "0660", "create", uids[1]);
  expect(second.status, second.stderr).toBe(0);
  const a = JSON.parse(first.stdout), b = JSON.parse(second.stdout);
  expect(a.identity).not.toBe(b.identity);
  expect(b.previous.record).toMatchObject({ state: "released", identity: a.identity, generation: 1 });
  expect(b.previous.recovery.resolution.outcome).toBe("completed");
  expect(b.record).toMatchObject({ generation: 2, identity: b.identity });
  for (const directory of b.directories) {
    expect(directory.mode).toBe(0o2770); expect(directory.gid).toBe(gid);
    expect(directory.files).toHaveLength(2);
    expect(directory.files.every((f: { mode: number; gid: number }) => f.mode === 0o660 && f.gid === gid)).toBe(true);
  }
  expect(b.operationsRoot).toEqual({ mode: 0o2770, gid }); expect(b.operations).toHaveLength(2);
  for (const operation of b.operations) {
    expect(operation).toMatchObject({ mode: 0o2770, gid });
    expect(operation.files.every((f: { mode: number; gid: number }) => f.mode === 0o660 && f.gid === gid)).toBe(true);
  }
  expect(directoryIdentity(root)).toEqual(before);
});

it.runIf(nativeIdentities)("does not widen pre-provisioned recovery directories to make another identity's write succeed", () => {
  const root = fixture(true), dir = path.join(root, "executions");
  mkdirSync(dir); chownSync(dir, 0, gid); chmodSync(dir, 0o2750);
  const before = directoryIdentity(dir), result = run(root, 0o077, "0660", "create", uids[0]);
  expect(result.status).toBe(1); expect(result.stderr).toContain("EACCES");
  expect(readdirSync(dir)).toEqual([]); expect(directoryIdentity(dir)).toEqual(before);
});
