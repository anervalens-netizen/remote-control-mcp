import { closeMcpValidation } from "./mcp-validation-client.ts";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
process.loadEnvFile(".env.mcp");const expected=process.argv[2];assert(expected,"Pass expected runtime SHA");
const agent=new AgentClient(),client=new Client({name:"power-release-validation",version:"1"});
const transport = new StreamableHTTPClientTransport(new URL(process.env.RCMCP_VALIDATION_URL ?? "http://127.0.0.1:45230/mcp"),{requestInit:{headers:{Authorization:"Bearer "+process.env.RCMCP_MCP_TOKEN}}});
await client.connect(transport);
async function tool(name:string,args:Record<string,unknown>){const raw=await client.callTool({name,arguments:args},undefined,{timeout:60000});assert(!raw.isError,JSON.stringify(raw));return JSON.parse((raw.content as Array<{text:string}>)[0]!.text)}
async function shell(device:string,context:"user"|"system",code:string){
  const encoded=Buffer.from(code).toString("base64"),r=await agent.exec(device,{command:"node -e \"eval(Buffer.from('"+encoded+"','base64').toString('utf8'))\"",timeoutMs:15000,maxOutputBytes:8192},context);
  assert.equal(r.code,0,JSON.stringify(r));return r.stdout.trim()?JSON.parse(r.stdout):null;
}
const receiver="const fs=require('node:fs'),path=require('node:path'),udp=require('node:dgram').createSocket('udp4');let count=0;const expected=Buffer.concat([Buffer.alloc(6,255),...Array.from({length:16},()=>Buffer.from('123456789abc','hex'))]);const timer=setTimeout(()=>{console.error('receiver timeout');udp.close();process.exitCode=2},15000);udp.on('error',e=>{throw e});udp.on('message',b=>{if(!b.equals(expected))throw Error('packet mismatch');if(++count===2){clearTimeout(timer);udp.close();console.log(JSON.stringify({count,bytes:b.length,matched:true}))}});udp.bind(0,'127.0.0.1',()=>fs.writeFileSync(path.join(__dirname,'ready.json'),JSON.stringify({port:udp.address().port})));";
const results:unknown[]=[];
try{
  for(const device of ["server","standby","Gaming"]){
    for(const context of ["user","system"] as const){
      const info=await agent.info(device,context) as any;assert.equal(info.runtime.sha,expected);
      for(const action of ["reboot","shutdown","sleep","hibernate","lock"]){
        const r=await tool("host_power",{device,context,action,delaySeconds:9000,dryRun:true});
        assert.equal(r.scheduled,false);assert.equal(r.powerStateVerified,false);assert.equal(r.plan.delaySeconds,9000);assert.equal(r.context,context);
      }
    }
    const context="system" as const;
    const fixture=await shell(device,context,"const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const dir=fs.mkdtempSync(p.join(os.tmpdir(),'rcmcp-wol-live-'));fs.writeFileSync(p.join(dir,'receiver.cjs'),"+JSON.stringify(receiver)+");console.log(JSON.stringify({dir}));");
    let job:any;
    try{
      job=await tool("job_start",{device,context,command:"node receiver.cjs",cwd:fixture.dir});
      const ready=await shell(device,context,"const fs=require('node:fs'),p=require('node:path');(async()=>{const file=p.join("+JSON.stringify(fixture.dir)+",'ready.json');for(let n=0;n<100;n++){if(fs.existsSync(file)){console.log(fs.readFileSync(file,'utf8'));return}await new Promise(r=>setTimeout(r,100));}throw Error('Receiver startup timeout');})();");
      const wake=await tool("wake_on_lan",{device,context,mac:"12:34:56:78:9a:bc",broadcast:"127.0.0.1",port:ready.port,repeat:2});
      assert.equal(wake.sent,true);assert.equal(wake.wakeVerified,false);
      const done=await tool("job_wait",{device,context,id:job.id,waitMs:20000});assert.equal(done.exitCode,0);assert.deepEqual(JSON.parse(done.stdout.data),{count:2,bytes:102,matched:true});
      results.push({device,powerPreviews:10,loopbackPackets:2,packetBytes:102,physicalPowerActions:0});
    }finally{
      if(job)await agent.jobRemove(device,{id:job.id,force:true},context);
      await shell(device,context,"require('node:fs').rmSync("+JSON.stringify(fixture.dir)+",{recursive:true,force:true});");
    }
  }
  console.log(JSON.stringify({sha:expected,results},null,2));
}finally{await closeMcpValidation(client,transport)}
