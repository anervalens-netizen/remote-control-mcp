import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync,readdirSync,readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe,it,expect } from "vitest";
import { ContextKeepBridge,jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
const scope=()=>({projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),leaseToken:randomUUID()});
describe("optional ContextKeep bridge",()=>{
 it("does not let ContextKeep downtime block execution and resumes retained terminal receipt after restart",async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"rc-ck-"));let starts=0,available=false;const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const client={jobStart:async()=>{starts++;return {id:"job-fixture",state:"completed"};},jobStatus:async()=>({id:"job-fixture",state:"completed",exitCode:0,finishedAt:"2026-01-01T00:00:00.000Z"})} as unknown as AgentClient;
  const call=async(name:string,args:Record<string,unknown>)=>{if(!available)throw new Error("offline");calls.push({name,args});return {};};
  const config={directory,url:"http://127.0.0.1/mcp",token:randomUUID()},work=scope(),input={command:"printf fixture",idempotencyKey:"one"};
  try{
   const first=new ContextKeepBridge(client,config,call);
   expect((await first.start("fixture","user",input,work) as {id:string}).id).toBe("job-fixture");
   await first.pump();expect(starts).toBe(1);
   available=true;const restarted=new ContextKeepBridge(client,config,call);await restarted.pump();
   expect(calls.map(x=>x.name)).toEqual(["attach_run_job","observe_run"]);
   expect(calls[1]!.args).toMatchObject({projectId:work.projectId,taskId:work.taskId,runId:work.runId,status:"completed",exitCode:0,identity:"owner"});
   expect(calls[0]!.args.inputHash).toBe(jobInputHash(input));
   await restarted.pump();expect(calls).toHaveLength(2);
   await restarted.start("fixture","user",input,work);expect(starts).toBe(1);
   const journal=readFileSync(path.join(directory,readdirSync(directory)[0]!),"utf8");expect(journal).not.toContain(input.command);expect(journal).not.toContain(config.token);
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
 it("preserves uncertainty after a lost start receipt and refuses automatic replay",async()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"rc-ck-"));let starts=0;
  const client={jobStart:async()=>{starts++;throw new Error("response lost");}} as unknown as AgentClient;
  const bridge=new ContextKeepBridge(client,{directory,url:"http://127.0.0.1/mcp",token:randomUUID()},async()=>({}));
  const input={command:"printf fixture",idempotencyKey:"one"},work=scope();
  try{
   await expect(bridge.start("fixture","user",input,work)).rejects.toThrow("response lost");
   await expect(bridge.start("fixture","user",input,work)).rejects.toThrow("job_start_uncertain");
   await bridge.pump();expect(starts).toBe(1);
   await expect(bridge.start("fixture","user",{...input,command:"different"},work)).rejects.toThrow("contextkeep_job_conflict");
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
});
