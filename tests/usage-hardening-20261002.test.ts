import { randomUUID } from "node:crypto";
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

  it("deduplicates real project_run durable starts when a key is supplied",async()=>{
    const root=await temp();
    await writeFile(path.join(root,"run.cjs"),'require("node:fs").appendFileSync("effect.txt","once\\n")');
    const key="project-"+randomUUID();
    const input={path:root,executable:process.execPath,args:["run.cjs"],mode:"job" as const,idempotencyKey:key};
    const [a,b]=await Promise.all([projectRun(input),projectRun(input)]);
    const first=a.result as {id:string}; const second=b.result as {id:string}; jobs.push(first.id);
    expect(second.id).toBe(first.id);
    expect(await jobStartKeyStatus(key)).toMatchObject({state:"resolved",jobId:first.id});
    await expect(jobFollow({id:first.id,waitMs:10000})).resolves.toMatchObject({terminal:true,exitCode:0});
  });

  it("deduplicates deploy_run and rejects changed input under the same key",async()=>{
    const root=await temp();
    await writeFile(path.join(root,"run.cjs"),'require("node:fs").appendFileSync("deploy-effect.txt","once\\n")');
    const key="deploy-"+randomUUID(), apply=nativeCommand([process.execPath,path.join(root,"run.cjs")]);
    const [a,b]=await Promise.all([deployRun({cwd:root,apply,idempotencyKey:key}),deployRun({cwd:root,apply,idempotencyKey:key})]);
    jobs.push(a.job!.id); expect(b.job!.id).toBe(a.job!.id);
    await expect(deployRun({cwd:root,apply:apply+" ",idempotencyKey:key})).rejects.toMatchObject({code:"job_start_conflict"});
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
      expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({error:"job_start_conflict",jobId:firstBody.result.id});
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
      requestRoute:async(_device:string,route:string)=>{seen.push(route);return {items:[{id:"historical"}],nextCursor:"next",partial:false,corruptCount:0,unreadableCount:0};},
      jobStatus:async()=>({id:"direct",state:"completed"}),
      jobStatusByKey:async(_device:string,key:string)=>({state:"resolved",jobId:"resolved",key}),
    } as unknown as AgentClient;
    const server=new McpServer({name:"usage-hardening",version:"1"});registerJobTools(server,fake);
    const client=new Client({name:"usage-hardening-client",version:"1"});
    const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
    try{
      const history=await client.callTool({name:"job_list",arguments:{device:"pc",history:true,limit:5,cursor:"cursor",state:"completed"}});
      expect(json(history)).toMatchObject({items:[{id:"historical"}],nextCursor:"next"});
      expect(seen[0]).toContain("/v1/jobs/history?");
      const lookup=await client.callTool({name:"job_status",arguments:{device:"pc",idempotencyKey:"stable-key"}});
      expect(json(lookup)).toMatchObject({state:"resolved",jobId:"resolved",key:"stable-key"});
    } finally {await client.close();await server.close();}
  });
});
