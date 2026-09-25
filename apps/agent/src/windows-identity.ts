import { spawnSync } from "node:child_process";
import { z } from "zod";

const tokenSchema=z.object({
  accountName:z.string().min(1),accountSid:z.string().regex(/^S-\d+(?:-\d+)+$/),
  isSystem:z.boolean(),isAdmin:z.boolean(),sessionId:z.number().int().nonnegative(),
});
export type WindowsTokenIdentity={
  verified:boolean;user:string|null;accountName:string|null;accountSid:string|null;
  isSystem:boolean;isAdmin:boolean;sessionId:number|null;error?:string;
};
function nativeToken():string{
  const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$i=[Security.Principal.WindowsIdentity]::GetCurrent();try{$p=[Security.Principal.WindowsPrincipal]::new($i);@{accountName=$i.Name;accountSid=$i.User.Value;isSystem=$i.IsSystem;isAdmin=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);sessionId=(Get-Process -Id $PID).SessionId}|ConvertTo-Json -Compress}finally{$i.Dispose()}";
  const probe=spawnSync("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{encoding:"utf8",timeout:3000,windowsHide:true});
  if(probe.error)throw probe.error;
  if(probe.status!==0)throw new Error("Windows token probe exited with status "+probe.status);
  return probe.stdout;
}
// Query the actual access token once at startup; inherited USERNAME is not identity.
export function readWindowsIdentity(read:()=>string=nativeToken):WindowsTokenIdentity{
  try{
    const value=tokenSchema.parse(JSON.parse(read().replace(/^\uFEFF/,"")));
    if(value.isSystem!==(value.accountSid==="S-1-5-18"))throw new Error("Inconsistent Windows SYSTEM token");
    return {verified:true,...value,user:value.accountName.split("\\").at(-1)!};
  }catch(error){
    return {verified:false,user:null,accountName:null,accountSid:null,isSystem:false,isAdmin:false,sessionId:null,error:error instanceof Error?error.message:String(error)};
  }
}
