import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify from "fastify";
import { JobStartDeduplicator } from "../apps/agent/src/job-start-dedup.ts";
import { jobCancel, jobRemove, jobStartKeyStatus } from "../apps/agent/src/jobs.ts";
import { jobFollow } from "../apps/agent/src/job-follow.ts";
import { projectRun } from "../apps/agent/src/project-run.ts";
import { deployRun } from "../apps/agent/src/deploy.ts";
import { nativeCommand } from "../apps/agent/src/shell-quote.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { probeFleetHost } from "../apps/mcp-server/src/fleet-probe.ts";
import { AgentRequestError, type AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { toolErrorDetails } from "../apps/mcp-server/src/tool-errors.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";

const roots:string[]=[];
const jobs:string[]=[];
afterEach(async()=>{
  for(const id of [...new Set(jobs.splice(0))]) { try{await jobCancel(id);}catch{} try{await jobRemove(id);}catch{} }
  for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true});
});
async function temp(){const root=await mkdtemp(path.join(os.tmpdir(),"rcmcp-usage-hardening-"));roots.push(root);return root;}
function json(result:unknown){const content=(result as {content:Array<{type:string;text?:string}>}).content;return JSON.parse(content[0]!.text!);}

describe("usage hardening 2026-10-02",()=>{
  it("reports actual runtime readiness separately from metrics",async()=>{
    const fake={
      info:async()=>({hostname:"pc",platform:"linux",arch:"x64",runtime:{ready:false}}),
      requestRoute:async()=>({hostname:"pc",platform:"linux",arch:"x64",totalMemoryBytes:100,freeMemoryBytes:50,rootFilesystem:{usedPercent:"50%",availableBytes:50}})
    } as unknown as AgentClient;
    await expect(probeFleetHost(fake,"pc","system",500)).resolves.toMatchObject({online:true,connectivity:"reachable",readiness:"not_ready",metricsStatus:"ok"});
    (fake.info as any)=async()=>({hostname:"pc",platform:"linux",arch:"x64",readiness:"ready",runtime:{ready:false}});
    await expect(probeFleetHost(fake,"pc","system",500)).resolves.toMatchObject({online:true,readiness:"not_ready"});
    (fake.info as any)=async()=>({hostname:"pc",platform:"linux",arch:"x64",runtime:{ready:true}});
    await expect(probeFleetHost(fake,"pc","system",500)).resolves.toMatchObject({online:true,readiness:"ready"});
  });

  it("looks up durable key reservations without starting or replaying work",async()=>{
    const root=await temp(), store=new JobStartDeduplicator(root), key="lookup-"+randomUUID();
    expect(store.lookup(key)).toEqual({state:"not_found"});
    const start=async(id:string)=>({id});
    const receipt=await store.run({command:"synthetic",idempotencyKey:key},start,async id=>({id}));
    expect(store.lookup(key)).toEqual({state:"reserved",jobId:receipt.id});
  });

  it("resolves keyed project retries before consulting mutable project manifests",async()=>{
    const root=await temp();
    await writeFile(path.join(root,"package.json"),JSON.stringify({scripts:{build:`${process.execPath.replaceAll("\\\\","/")} -e "process.stdout.write(\'built\')"`}}));
    const key="project-"+randomUUID();
    const input={path:root,action:"build" as const,mode:"job" as const,idempotencyKey:key};
    const first=await projectRun(input); const firstJob=first.result as {id:string}; jobs.push(firstJob.id);
    await expect(jobFollow({id:firstJob.id,waitMs:10000})).resolves.toMatchObject({terminal:true,exitCode:0});
    await rm(root,{recursive:true,force:true});
    const replay=await projectRun(input); const replayJob=replay.result as {id:string};
    expect(replayJob.id).toBe(firstJob.id); expect(replay.plan).toEqual(first.plan);
    expect(await jobStartKeyStatus(key)).toMatchObject({state:"resolved",jobId:firstJob.id});
  });

  it("preserves the original deploy snapshot across keyed retries after the repo disappears",async()=>{
    const root=await temp();
    execFileSync("git",["init"],{cwd:root}); execFileSync("git",["config","user.email","test@example.invalid"],{cwd:root}); execFileSync("git",["config","user.name","test"],{cwd:root});
    await writeFile(path.join(root,"tracked.txt"),"before\\n"); execFileSync("git",["add","tracked.txt"],{cwd:root}); execFileSync("git",["commit","-m","initial"],{cwd:root});
    const key="deploy-"+randomUUID(), apply=nativeCommand([process.execPath,"-e","process.stdout.write(\'deployed\')"]);
    const first=await deployRun({repoPath:root,apply,idempotencyKey:key}); jobs.push(first.job!.id);
    await expect(jobFollow({id:first.job!.id,waitMs:10000})).resolves.toMatchObject({terminal:true,exitCode:0});
    await rm(root,{recursive:true,force:true});
    const replay=await deployRun({repoPath:root,apply,idempotencyKey:key});
    expect(replay.job!.id).toBe(first.job!.id); expect(replay.before).toEqual(first.before);
    await expect(deployRun({repoPath:root,apply:apply+" ",idempotencyKey:key})).rejects.toMatchObject({code:"job_start_conflict"});
  });

  it("preserves typed duplicate-start conflicts through the project HTTP route",async()=>{
    const root=await temp();
    await writeFile(path.join(root,"run.cjs"),"process.stdout.write(\"ok\")");
    const app=Fastify({logger:false}); registerExtraRoutes(app); await app.ready();
    try {
      const key="http-project-"+randomUUID();
      const first=await app.inject({method:"POST",url:"/v1/project/run",payload:{path:root,executable:process.execPath,args:["run.cjs"],mode:"job",idempotencyKey:key}});
      expect(first.statusCode).toBe(200); const firstBody=first.json(); jobs.push(firstBody.result.id);
      const conflict=await app.inject({method:"POST",url:"/v1/project/run",payload:{path:root,command:"printf changed",mode:"job",idempotencyKey:key}});
      expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({error:"job_start_conflict"});
    } finally { await app.close(); }
  });

  it("keeps typed agent causes in structured tool errors",()=>{
    const error=new AgentRequestError("missing","pc","user","/v1/fs/read","http",500,undefined,false,undefined,"ENOENT");
    expect(toolErrorDetails(error)).toMatchObject({device:"pc",context:"user",route:"/v1/fs/read",kind:"http",status:500,agentCode:"ENOENT"});
  });

  it("routes job_list history and job_status key lookup through already exposed tools",async()=>{
    const seen:string[]=[];
    const fake={
      devices:[{name:"pc"}],
      configuredContexts:()=>({system:true,user:true,desktop:false}),
      jobs:async()=>[{id:"recent"}],
      requestRoute:async(_device:string,route:string)=>{seen.push(route);return {items:Array.from({length:80},(_,i)=>({id:`historical-${i}`,state:"completed",startedAt:`2026-10-02T08:${String(i%60).padStart(2,"0")}:00.000Z`,detail:"x".repeat(1800)})),nextCursor:"server-next",partial:false,corruptCount:0,unreadableCount:0};},
      jobStatus:async()=>({id:"direct",state:"completed"}),
      jobStatusByKey:async()=>({state:"resolved",jobId:"resolved",job:{id:"resolved",state:"completed"}}),
    } as unknown as AgentClient;
    const server=new McpServer({name:"usage-hardening",version:"1"});installDefaultToolOutputContracts(server);registerJobTools(server,fake);
    const client=new Client({name:"usage-hardening-client",version:"1"});
    const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
    try{
      const history=await client.callTool({name:"job_list",arguments:{device:"pc",history:true,limit:80,cursor:"cursor",state:"completed"}});
      const legacy=json(history); expect(legacy.items[0]).toMatchObject({id:"historical-0",state:"completed"});
      expect(seen[0]).toContain("/v1/jobs/history?");
      const structured=(history as any).structuredContent; expect(structured.items.length).toBeLessThan(80); expect(structured.nextCursor).not.toBe("server-next");
      const decoded=JSON.parse(Buffer.from(structured.nextCursor,"base64url").toString("utf8")); expect(decoded.id).toBe(structured.items.at(-1).id);
      const lookup=await client.callTool({name:"job_status",arguments:{device:"pc",idempotencyKey:"stable-key"}});
      expect(json(lookup)).toMatchObject({state:"resolved",jobId:"resolved",job:{id:"resolved",state:"completed"}});
    } finally {await client.close();await server.close();}
  });
});
