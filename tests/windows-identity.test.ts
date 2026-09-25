import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect,it } from "vitest";
import { readWindowsIdentity } from "../apps/agent/src/windows-identity.ts";

it("reports unavailable token probes without inventing a privilege",()=>{
  const result=readWindowsIdentity(()=>{throw new Error("token probe unavailable")});
  expect(result).toMatchObject({verified:false,accountSid:null,isSystem:false,isAdmin:false,error:"token probe unavailable"});
  expect(readWindowsIdentity(()=>"not JSON").verified).toBe(false);
});
it("rejects contradictory token data instead of publishing SYSTEM",()=>{
  expect(readWindowsIdentity(()=>JSON.stringify({accountName:"PC\\owner",accountSid:"S-1-5-21-1",isSystem:true,isAdmin:false,sessionId:1}))).toMatchObject({verified:false,error:"Inconsistent Windows SYSTEM token"});
});
it.skipIf(process.platform!=="win32")("reports the actual native token despite misleading USERNAME and context defaults",()=>{
  const expected=readWindowsIdentity();expect(expected.verified,expected.error).toBe(true);
  const moduleUrl=new URL("../apps/agent/src/runtime.ts",import.meta.url).href;
  const code="const {runtimeStatus}=await import("+JSON.stringify(moduleUrl)+");console.log(JSON.stringify(runtimeStatus()))";
  for(const user of ["GAMING$","SYSTEM","misleading-owner"]){
    const env={...process.env,USERNAME:user,RCMCP_RUNTIME_CONTEXT:"",RCMCP_DESKTOP_ENABLED:"0"};
    const result=JSON.parse(execFileSync(process.execPath,["--input-type=module","-e",code],{env,encoding:"utf8",timeout:20000,cwd:fileURLToPath(new URL("..",import.meta.url))}));
    expect(result.accountSid).toBe(expected.accountSid);
    expect(result.accountName).toBe(expected.accountName);
    expect(result.user).toBe(expected.user);
    expect(result.privilege).toBe(expected.isSystem?"system":expected.isAdmin?"admin":"user");
    expect(result.context).toBe(expected.isSystem?"system":"unknown");
    expect(result.processSessionId).toBe(expected.sessionId);
    expect(result.checks.identity).toMatchObject({verified:true,source:"windows-token",accountSid:expected.accountSid});
  }
},70000);
