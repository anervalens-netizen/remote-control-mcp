import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";

process.loadEnvFile(process.env.RCMCP_VALIDATION_ENV_FILE ?? path.resolve(".env.mcp"));
const server=new McpServer({name:"isolated-result-validation",version:"1"}); registerTools(server,new AgentClient());
const client=new Client({name:"m16-results",version:"1"}); const [st,ct]=InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st),client.connect(ct)]);
const results:Array<{name:string;ok:boolean;error?:string}>=[];
async function call(name:string,args:Record<string,unknown>={}){
  try {
    const raw=await client.callTool({name,arguments:args},undefined,{timeout:90000});
    if(raw.isError)throw new Error(JSON.stringify(raw.content));
    results.push({name,ok:true});
    return (raw.structuredContent??JSON.parse((raw.content as Array<{text:string}>)[0]!.text)) as any;
  }catch(error){results.push({name,ok:false,error:error instanceof Error?error.message:String(error)});return null;}
}
const repo=process.env.RCMCP_VALIDATION_REPO ?? "/home/operator/work/remote-control-mcp";
const readOnly:Array<[string,Record<string,unknown>]>=[
  ["devices_list",{}],["capability_report",{}],["device_info",{device:"server",identity:"owner"}],
  ["fleet_status",{devices:["server","standby"]}],["system_metrics",{device:"server",profile:"light"}],
  ["process_list",{device:"Gaming",identity:"root"}],["process_find",{device:"Gaming",limit:3}],["gpu_snapshot",{device:"Gaming"}],
  ["process_find",{device:"server",query:"remote-control",limit:3}],["process_list",{device:"server",identity:"owner"}],
  ["fs_manage",{device:"server",identity:"owner",operation:"stat",path:repo+"/README.md"}],
  ["fs_list",{device:"server",identity:"owner",path:repo+"/config"}],
  ["fs_read",{device:"server",identity:"owner",path:repo+"/README.md",length:100}],
  ["search",{device:"server",context:"user",path:repo+"/README.md",pattern:"remote",maxResults:1}],
  ["repo_snapshot",{device:"server",path:repo,profile:"summary"}],
  ["repo_compare",{items:[{device:"server",path:repo},{device:"standby",path:repo}]}],
  ["repo_git_path",{device:"server",path:repo,gitPath:"HEAD"}],
  ["docker_summary",{device:"server",limit:1}],["docker_snapshot",{device:"server"}],
  ["network_snapshot",{device:"server"}],["storage_snapshot",{device:"server"}],["gpu_snapshot",{device:"server"}],
  ["package_managers",{device:"server"}],["host_inventory",{device:"server",profile:"light"}],
  ["service_manage",{device:"server",name:"remote-control-agent",action:"status",scope:"system"}],
  ["service_logs",{device:"server",name:"remote-control-agent",scope:"system",lines:1}],
  ["service_inspect",{device:"server",name:"remote-control-agent",scope:"system",lines:1}],
  ["host_power",{device:"server",action:"lock",dryRun:true}],
  ["secret_status",{alias:"m16-nonexistent-validation-alias"}],
  ["job_list",{device:"server",identity:"owner",limit:1}],
  ["pty_list",{device:"server",identity:"owner"}],
  ["browser_session",{device:"server",action:"list"}],
  ["deploy_run",{device:"server",identity:"owner",command:"echo M16_PREVIEW",dryRun:true}],
];
try {
  const listed=await client.listTools();assert(listed.tools.length>=87);assert(listed.tools.every(t=>t.outputSchema));
  const names=new Set(listed.tools.map(t=>t.name));assert.equal(names.size,listed.tools.length);
  for(const name of ["browser_execution","job_lineage","file_transfer","fs_manage"])assert(names.has(name),`Missing ${name}`);
  for(const [name,args]of readOnly)await call(name,args);
  const search=await call("search_start",{device:"server",context:"user",path:repo+"/README.md",pattern:"remote",maxResults:2});
  if(search?.id){try{
    await new Promise(resolve=>setTimeout(resolve,100));
    await call("search_results",{device:"server",context:"user",id:search.id});
    await call("search_sessions",{device:"server",context:"user"});
    await call("search_stop",{device:"server",context:"user",id:search.id});
  }finally{await call("search_remove",{device:"server",context:"user",id:search.id,force:true});}}
  const job=await call("job_start",{device:"server",identity:"owner",elevation:"never",command:"id -u"});
  if(job?.id){
    try{
      const done=await call("job_wait",{device:"server",identity:"owner",id:job.id,waitMs:5000});
      if(done?.stdout?.data?.trim()!=="1000")results.push({name:"job-owner-uid",ok:false,error:"expected UID1000"});
      await call("job_status",{device:"server",identity:"owner",id:job.id});
      await call("job_output",{device:"server",identity:"owner",id:job.id});
      await call("job_output_since",{device:"server",identity:"owner",id:job.id});
    }finally{await call("job_remove",{device:"server",identity:"owner",id:job.id});}
  }
  console.log(JSON.stringify({mode:"isolated-new-MCP-registry-to-live-agents",tools:listed.tools.length,passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok),results},null,2));
  if(results.some(r=>!r.ok))process.exitCode=1;
} finally {await client.close();await server.close();}
