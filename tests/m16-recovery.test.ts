import fs from "node:fs";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverMoveCaptures } from "../apps/agent/src/filesystem-atomic.ts";
import { atomicWriteJson, ensureStateDir } from "../apps/agent/src/state.ts";
const roots: string[]=[]; const journals: string[]=[];
afterEach(async()=>{for(const p of journals.splice(0))await fsp.rm(p,{force:true}); for(const p of roots.splice(0))await fsp.rm(p,{recursive:true,force:true});});
describe("M16 conservative move commit recovery",()=>{
  it.each(["activating","destination-durable"])("does not resurrect a committed source after a crash in %s",async phase=>{
    const root=await fsp.mkdtemp(path.join(os.tmpdir(),"m16-move-"));roots.push(root);
    const source=path.join(root,"source"),capture=path.join(root,"capture"),destination=path.join(root,"destination");
    await fsp.writeFile(capture,"original");await fsp.writeFile(destination,"original");
    const stat=await fsp.lstat(destination);const journal=path.join(ensureStateDir("move-captures"),randomUUID()+".json");journals.push(journal);
    atomicWriteJson(journal,{version:2,phase,source,capture,destination,destinationIdentity:{dev:stat.dev,ino:stat.ino,birthtimeMs:stat.birthtimeMs},createdAt:new Date().toISOString()});
    const result=await recoverMoveCaptures();
    expect(result.errors).toEqual([]);expect(result.activatedRetained).toBeGreaterThan(0);
    expect(fs.existsSync(source)).toBe(false);expect(await fsp.readFile(capture,"utf8")).toBe("original");expect(await fsp.readFile(destination,"utf8")).toBe("original");
  });
  it("restores the source if the recorded destination no longer exists",async()=>{
    const root=await fsp.mkdtemp(path.join(os.tmpdir(),"m16-move-missing-"));roots.push(root);
    const source=path.join(root,"source"),capture=path.join(root,"capture"),destination=path.join(root,"missing");await fsp.writeFile(capture,"recoverable");
    const journal=path.join(ensureStateDir("move-captures"),randomUUID()+".json");journals.push(journal);
    atomicWriteJson(journal,{version:2,phase:"destination-durable",source,capture,destination,destinationIdentity:{dev:0,ino:0,birthtimeMs:0},createdAt:new Date().toISOString()});
    expect((await recoverMoveCaptures()).errors).toEqual([]);expect(await fsp.readFile(source,"utf8")).toBe("recoverable");
  });
});
it.skipIf(process.platform!=="win32")("restores the persisted owner's startup, independently of the elevated account",async()=>{
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),"m16-owner-"));roots.push(root);
  const helper=path.resolve("deploy/windows/startup-state.ps1").replace(/'/g,"''");
  const script=`$ErrorActionPreference='Stop'; . '${helper}'; $owner=Join-Path $env:M16_OWNER_ROOT 'original-owner'; $other=Join-Path $env:M16_OWNER_ROOT 'different-admin'; $state=Get-RcmcpStartupState $owner; [IO.Directory]::CreateDirectory((Split-Path $state.backup -Parent))|Out-Null; [IO.File]::WriteAllText($state.backup,'OWNER-CONTENT'); $manifest=Join-Path $env:M16_OWNER_ROOT 'state.json'; Save-RcmcpStartupState $manifest $state; $env:USERPROFILE=$other; $loaded=Read-RcmcpStartupState $manifest; $result=Restore-RcmcpStartupState $loaded; if(-not $result.restored){throw 'not restored'}; if([IO.File]::ReadAllText($state.userHost) -ne 'OWNER-CONTENT'){throw 'wrong owner'}; $again=Restore-RcmcpStartupState $loaded; if(-not $again.alreadyPresent){throw 'not idempotent'}; Write-Output 'OWNER_RESTORE_PASS'`;
  expect(execFileSync("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Command",script],{encoding:"utf8",windowsHide:true,env:{...process.env,M16_OWNER_ROOT:root},timeout:15000})).toContain("OWNER_RESTORE_PASS");
},20000);
