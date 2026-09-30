import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ContextKeepBridge } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
const dirs: string[] = [], bridges: ContextKeepBridge[] = [];
afterEach(async()=>{ await Promise.all(bridges.splice(0).map(b=>b.close())); vi.useRealTimers();vi.restoreAllMocks();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(path.join(os.tmpdir(),"ck-poll-page-"));dirs.push(directory);
 const work={projectId:randomUUID(),taskId:randomUUID(),runId:randomUUID(),leaseToken:randomUUID()};
 const run={id:work.runId,projectId:work.projectId,taskId:work.taskId,externalJobId:"synthetic-job",device:"fixture",identity:"owner",status:"running",verification:"pending",revision:2};
 return {directory,work,run,config:{directory,url:"http://127.0.0.1/mcp",token:"synthetic"},journal:()=>JSON.parse(readFileSync(path.join(directory,readdirSync(directory).find(f=>f.endsWith('.json'))!),"utf8"))};
}
it.each(["shutdown","deadline"])("cancels the underlying executor status fetch on %s",async mode=>{
 const f=fixture();vi.useFakeTimers();let signal:AbortSignal|undefined;let aborted=false;let entered!:()=>void;
 const polled=new Promise<void>(resolve=>{entered=resolve;});
 const client={jobStart:vi.fn(async()=>({id:"synthetic-job"})),jobStatus:vi.fn(async(_device:unknown,_id:unknown,_context:unknown,options?:{signal?:AbortSignal})=>{
   signal=options?.signal;entered();return new Promise<never>((_resolve,reject)=>{signal?.addEventListener("abort",()=>{aborted=true;reject(new Error("synthetic fetch aborted"));},{once:true});});
 })};
 const bridge=new ContextKeepBridge(client as unknown as AgentClient,f.config,async name=>name==="get_task"?{task:{id:f.work.taskId},runs:[f.run],pagination:{totalRuns:1,offset:0,limit:50}}:{run:f.run});bridges.push(bridge);
 await bridge.start("fixture","user",{command:"synthetic",idempotencyKey:"one"},f.work);
 const pump=bridge.pump();await polled;
 if(mode==="shutdown")await bridge.close();else await vi.advanceTimersByTimeAsync(30001);
 await pump;
 expect(signal).toBeInstanceOf(AbortSignal);expect(signal?.aborted).toBe(true);expect(aborted).toBe(true);
 expect(client.jobStart).toHaveBeenCalledTimes(1);expect(f.journal().state).toBe("tracking");
});
it("reconciles a run beyond 500 entries across bounded attempts, without replay or lost attach proof",async()=>{
 const f=fixture();let now=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>now);const offsets:number[]=[];
 const client={jobStart:vi.fn(async()=>({id:"synthetic-job"})),jobStatus:vi.fn(async()=>({id:"synthetic-job",state:"completed",exitCode:0,finishedAt:"2026-01-01T00:00:00.000Z"}))};
 const caller=vi.fn(async(name:string,args:Record<string,unknown>)=>{
   if(name==="attach_run_job")return {run:{...f.run}};
   if(name!=="get_task")throw new Error("No terminal write is required for an already completed run");
   const offset=Number(args.offset);offsets.push(offset);
   return {task:{id:f.work.taskId},runs:offset===550?[{...f.run,status:"completed",verification:"passed"}]:[],pagination:{totalRuns:601,offset,limit:50}};
 });
 const bridge=new ContextKeepBridge(client as unknown as AgentClient,f.config,caller);bridges.push(bridge);
 await bridge.start("fixture","user",{command:"synthetic",idempotencyKey:"one"},f.work);await bridge.pump();
 expect(offsets).toEqual([0,50,100,150,200,250,300,350,400,450]);
 expect(f.journal()).toMatchObject({state:"tracking",attachAcknowledged:true,lastError:"proof_missing"});
 now+=2001;await bridge.pump();
 expect(offsets).toEqual([0,50,100,150,200,250,300,350,400,450,500,550]);
 expect(f.journal()).toMatchObject({state:"delivered",attachAcknowledged:true});expect(client.jobStart).toHaveBeenCalledTimes(1);
 expect(caller.mock.calls.filter(c=>c[0]==="observe_run")).toHaveLength(0);
});
