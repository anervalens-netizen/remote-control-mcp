import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { serviceCanonicalKey } from "../apps/agent/src/coordination-resource.ts";
import { coordinationFileMode, coordinationHash, ResourceCoordinator } from "../apps/agent/src/coordination.ts";
import { isCoordinatedWrite } from "../packages/protocol/src/coordination.ts";

it("Windows service user/system and identity aliases share a fence; Linux user services stay distinct", () => {
  const owner = coordinationHash("owner"), system = coordinationHash("system");
  const c = new ResourceCoordinator(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "platform-coord-")));
  const resource = (scope: "user" | "system", identity: string, platform: NodeJS.Platform, name = "Synthetic") => ({
    device: coordinationHash("device"), identity, baseVersion: coordinationHash("base"), canonicalKey: serviceCanonicalKey(name, scope, identity, platform),
  });
  const first = resource("user", owner, "win32");
  c.acquire(first);
  expect(resource("system", system, "win32", "SYNTHETIC").canonicalKey).toBe(first.canonicalKey);
  expect(() => c.acquire(resource("system", system, "win32", "SYNTHETIC"))).toThrow("writer_reserved");
  expect(serviceCanonicalKey("synthetic", undefined, owner, "win32")).toBe(first.canonicalKey);
  const linuxUser = resource("user", owner, "linux");
  expect(linuxUser.canonicalKey).not.toBe(resource("system", owner, "linux").canonicalKey);
  expect(linuxUser.canonicalKey).not.toBe(resource("user", system, "linux").canonicalKey);
  expect(resource("system", owner, "linux").canonicalKey).toBe(resource("system", system, "linux").canonicalKey);
});

it.each([
  ["/v1/repo/apply-patch", "checkOnly"], ["/v1/repo/checkpoint", "dryRun"],
  ["/v1/repo/push", "dryRun"], ["/v1/project/run", "dryRun"], ["/v1/deploy/run", "dryRun"],
])("only supported read-only flags exempt %s", (route, supported) => {
  expect(isCoordinatedWrite(route, { path: "synthetic", repoPath: "synthetic", [supported]: true })).toBe(false);
  const unsupported = supported === "dryRun" ? "checkOnly" : "dryRun";
  expect(isCoordinatedWrite(route, { path: "synthetic", repoPath: "synthetic", [unsupported]: true })).toBe(true);
});
it.each(["/v1/repo/fetch", "/v1/repo/pull", "/v1/service"])("unsupported flags never exempt %s", route => {
  expect(isCoordinatedWrite(route, { path: "synthetic", action: "restart", dryRun: true, checkOnly: true })).toBe(true);
});

it("shared file mode is explicit and rejects invalid or world-accessible modes", () => {
  expect(coordinationFileMode()).toBe(0o600);
  expect(coordinationFileMode("0660")).toBe(0o660);
  for (const value of ["", "0666", "0777", "660garbage"]) expect(() => coordinationFileMode(value)).toThrow("RCMCP_COORDINATION_FILE_MODE");
});

it.runIf(process.platform === "linux")("journal replacements, slots and locks retain configured modes across process umasks", () => {
  const script = `
import {ResourceCoordinator,coordinationFileMode,coordinationHash,coordinationToken} from ${JSON.stringify(new URL("../apps/agent/src/coordination.ts", import.meta.url).href)};
import {readdirSync,statSync} from 'node:fs';
import path from 'node:path';
const [root,mask,action,serialized] = process.argv.slice(1);
process.umask(Number(mask));
const mode=coordinationFileMode(process.env.RCMCP_COORDINATION_FILE_MODE), locks=[], snapshots=[];
const now=()=>{for(const f of readdirSync(root).filter(f=>f.endsWith('.lock'))) locks.push(statSync(path.join(root,f)).mode&0o777);return Date.now();};
const c=new ResourceCoordinator(root,4,now,mode);
const resource={device:coordinationHash('device'),identity:coordinationHash('owner'),canonicalKey:coordinationHash('repo'),baseVersion:coordinationHash('base')};
const snapshot=()=>snapshots.push(readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>({file:f,mode:statSync(path.join(root,f)).mode&0o777,ino:statSync(path.join(root,f)).ino})));
let record;
if(action==='acquire'){record=c.acquire(resource);snapshot();}
else {
 const token=JSON.parse(serialized);
 let conflict;try{c.acquire({...resource,identity:coordinationHash('system')});}catch(e){conflict=e.reason;}
 if(conflict!=='writer_reserved')throw new Error('cross-identity reservation lost');
 c.begin(token,resource);snapshot();c.settle(token);snapshot();
 record=c.acquire({...resource,identity:coordinationHash('system')});snapshot();
 c.release(coordinationToken(record));snapshot();
}
process.stdout.write(JSON.stringify({record,locks,snapshots}));
`;
  for (const configured of [undefined, "0660"]) {
    const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "mode-coord-"));
    const directoryMode = statSync(root).mode;
    const env = { ...process.env }; delete env.RCMCP_COORDINATION_FILE_MODE;
    if (configured) env.RCMCP_COORDINATION_FILE_MODE = configured;
    const run = (mask: number, action: string, token = "") => JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "-e", script, root, String(mask), action, token], { env, encoding: "utf8" }));
    const first = run(0o077, "acquire");
    const { resourceId, operationId, generation, baseVersion } = first.record;
    const second = run(0o027, "settle", JSON.stringify({ resourceId, operationId, generation, baseVersion }));
    expect(second.record.generation).toBe(2);
    const expected = configured ? 0o660 : 0o600;
    for (const result of [first, second]) {
      expect(result.locks.length).toBeGreaterThan(0);
      expect(result.locks.every((mode: number) => mode === expected)).toBe(true);
      for (const snapshot of result.snapshots) {
        expect(snapshot.length).toBeGreaterThan(0);
        expect(snapshot.every((file: { mode: number }) => file.mode === expected)).toBe(true);
      }
    }
    expect(first.snapshots[0].some((file: { file: string }) => file.file.startsWith("slot-"))).toBe(true);
    const journal = (snapshot: Array<{ file: string; ino: number }>) => snapshot.find(file => file.file === resourceId + ".json")!;
    expect(journal(second.snapshots[0]).ino).not.toBe(journal(first.snapshots[0]).ino);
    expect(journal(second.snapshots[1]).ino).not.toBe(journal(second.snapshots[0]).ino);
    expect(statSync(root).mode).toBe(directoryMode);
  }
});
