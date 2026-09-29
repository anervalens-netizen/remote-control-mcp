import { createHash,randomUUID } from "node:crypto";
import { mkdirSync,openSync,closeSync,writeFileSync,readFileSync,renameSync,readdirSync,fsyncSync,existsSync } from "node:fs";
import path from "node:path";
import type { AgentClient,AgentEndpointContext } from "./agent-client.ts";
import { executionLabel } from "./execution-identity.ts";
export type WorkCorrelation={projectId:string;taskId:string;runId:string;leaseToken:string};
type Entry={version:1;key:string;hash:string;device:string;target:AgentEndpointContext;correlation:WorkCorrelation;state:"job_start_uncertain"|"tracking"|"delivered";jobId?:string;observed?:{state:string;exitCode:number|null;finishedAt:string};attachKey:string;observeKey:string};
type Config={directory:string;url:string;token:string};
type Caller=(name:string,args:Record<string,unknown>)=>Promise<unknown>;
export function jobInputHash(input:{command:string;cwd?:string;env?:Record<string,string>}) {
 return createHash("sha256").update(JSON.stringify({command:input.command,cwd:input.cwd??null,env:Object.fromEntries(Object.entries(input.env??{}).sort(([a],[b])=>a.localeCompare(b)))})).digest("hex");
}
export class ContextKeepBridge {
 private client:AgentClient;private config:Config;private call:Caller;private timer:ReturnType<typeof setInterval>|undefined;private busy:Promise<void>|undefined;
 constructor(client:AgentClient,config:Config,call?:Caller) {
  if(!path.isAbsolute(config.directory))throw new Error("Bridge directory must be absolute.");
  const url=new URL(config.url);if(url.username||url.password||!["http:","https:"].includes(url.protocol))throw new Error("Invalid configured bridge endpoint.");
  if(url.protocol==="http:"&&!["127.0.0.1","[::1]","localhost"].includes(url.hostname))throw new Error("Bridge HTTP is loopback-only.");
  this.client=client;this.config=config;mkdirSync(config.directory,{recursive:true,mode:0o700});
  this.call=call??(async(name,args)=>{
   const response=await fetch(config.url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{authorization:`Bearer ${config.token}`,"content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:randomUUID(),method:"tools/call",params:{name,arguments:args}})});
   if(!response.ok)throw new Error("ContextKeep unavailable.");
   const reader=response.body?.getReader();if(!reader)throw new Error("Empty ContextKeep response.");
   let bytes=0;const parts:Uint8Array[]=[];try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>1024*1024)throw new Error("ContextKeep response too large.");parts.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
   const result=JSON.parse(Buffer.concat(parts).toString("utf8"));if(result.error||result.result?.isError)throw new Error("ContextKeep rejected bridge write.");
   return result.result?.structuredContent;
  });
 }
 private file(key:string){return path.join(this.config.directory,key+".json");}
 private save(entry:Entry,create=false){
  const file=this.file(entry.key),temporary=file+"."+randomUUID()+".tmp";
  const fd=openSync(create?file:temporary,create?"wx":"w",0o600);
  try{writeFileSync(fd,JSON.stringify(entry));fsyncSync(fd);}finally{closeSync(fd);}
  if(!create)renameSync(temporary,file);
  if(process.platform!=="win32"){const dir=openSync(this.config.directory,"r");try{fsyncSync(dir);}finally{closeSync(dir);}}
 }
 private read(key:string){return JSON.parse(readFileSync(this.file(key),"utf8")) as Entry;}
 async start(device:string,target:AgentEndpointContext,input:{command:string;cwd?:string;env?:Record<string,string>;idempotencyKey?:string},correlation:WorkCorrelation) {
  if(!input.idempotencyKey)throw new Error("Correlated jobs require a stable idempotencyKey.");
  const key=createHash("sha256").update(JSON.stringify([device,target,input.idempotencyKey])).digest("hex"),hash=jobInputHash(input);
  if(existsSync(this.file(key))){
   const prior=this.read(key);
   if(prior.hash!==hash||JSON.stringify(prior.correlation)!==JSON.stringify(correlation))throw new Error("contextkeep_job_conflict");
   if(!prior.jobId)throw new Error("job_start_uncertain: inspect the retained executor reservation; automatic replay is disabled.");
   return this.client.jobStatus(device,prior.jobId,target);
  }
  const entry:Entry={version:1,key,hash,device,target,correlation,state:"job_start_uncertain",attachKey:randomUUID(),observeKey:randomUUID()};
  this.save(entry,true);
  // A network error or crash deliberately leaves uncertainty. No automatic jobStart retries.
  const result=await this.client.jobStart(device,input,target) as {id?:string};
  if(!result.id)throw new Error("job_start_uncertain: executor returned no job identity.");
  entry.jobId=result.id;entry.state="tracking";this.save(entry);
  return result;
 }
 async pump() {
  for(const file of readdirSync(this.config.directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f))){
   const entry=this.read(file.slice(0,-5));if(entry.state!=="tracking"||!entry.jobId)continue;
   try{
    const scope={projectId:entry.correlation.projectId,taskId:entry.correlation.taskId,runId:entry.correlation.runId,clientId:"remote-control",sessionId:"executor-bridge"};
    await this.call("attach_run_job",{...scope,leaseToken:entry.correlation.leaseToken,externalJobId:entry.jobId,inputHash:entry.hash,idempotencyKey:entry.attachKey});
    if(!entry.observed){
     const status=await this.client.jobStatus(entry.device,entry.jobId,entry.target) as {state?:string;exitCode?:number|null;finishedAt?:string};
     if(!status.state||!["completed","cancelled","lost"].includes(status.state))continue;
     entry.observed={state:status.state,exitCode:status.exitCode??null,finishedAt:status.finishedAt??new Date().toISOString()};this.save(entry);
    }
    const observation=entry.observed;
    const status=observation.state==="completed"?(observation.exitCode===0?"completed":"failed"):observation.state;
    await this.call("observe_run",{...scope,externalJobId:entry.jobId,device:entry.device,identity:executionLabel(entry.target),eventKey:entry.key,status,exitCode:observation.exitCode,observedAt:observation.finishedAt,idempotencyKey:entry.observeKey});
    entry.state="delivered";this.save(entry);
   }catch{/* Optional integration retries retained receipts; executor remains independent. */}
  }
 }
 startWorker(){if(this.timer)return;this.timer=setInterval(()=>{if(!this.busy)this.busy=this.pump().catch(()=>{}).finally(()=>{this.busy=undefined;});},2000);this.timer.unref();}
 async close(){if(this.timer)clearInterval(this.timer);await this.busy;}
}
const instances=new WeakMap<AgentClient,ContextKeepBridge>();const active=new Set<ContextKeepBridge>();
export function configuredContextKeepBridge(client:AgentClient) {
 const prior=instances.get(client);if(prior)return prior;
 const directory=process.env.RCMCP_CONTEXTKEEP_STATE_DIR,url=process.env.RCMCP_CONTEXTKEEP_URL,token=process.env.RCMCP_CONTEXTKEEP_TOKEN;
 if(!directory||!url||!token)return undefined;
 const bridge=new ContextKeepBridge(client,{directory,url,token});instances.set(client,bridge);active.add(bridge);bridge.startWorker();return bridge;
}
export async function closeContextKeepBridges(){await Promise.all([...active].map(b=>b.close()));active.clear();}
