import { closeMcpValidation } from "./mcp-validation-client.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
process.loadEnvFile(".env.mcp");
const expected=process.argv[2];assert(expected,"Pass expected runtime SHA");
const client=new Client({name:"browser-release-validation",version:"1"}),agent=new AgentClient();
const transport = new StreamableHTTPClientTransport(new URL(process.env.RCMCP_VALIDATION_URL ?? "http://127.0.0.1:45230/mcp"),{requestInit:{headers:{Authorization:"Bearer "+process.env.RCMCP_MCP_TOKEN}}});
await client.connect(transport);
async function call(target:Client,name:string,args:Record<string,unknown>){
  const raw=await target.callTool({name,arguments:args},undefined,{timeout:90000});
  assert(!raw.isError,JSON.stringify(raw));return {raw,body:JSON.parse((raw.content as Array<{text:string}>)[0]!.text)};
}
const result:unknown[]=[];
try{
  const listed=await client.listTools();assert(listed.tools.some(t=>t.name==="browser_action"));
  for(const device of ["server","standby","Gaming"])for(const context of ["user","system"] as const){
    const info=await agent.info(device,context) as any;assert.equal(info.runtime.sha,expected);
  }
  for(const device of ["server","Gaming"]){
    const {body:session}=await call(client,"browser_session",{device,action:"start",headless:true});
    try{
      const html='<meta charset="UTF-8"><label>Name<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output></output>';
      const {body,raw}=await call(client,"browser_action",{device,sessionId:session.sessionId,actions:[
        {action:"goto",url:"data:text/html;charset=utf-8,"+encodeURIComponent(html)},
        {action:"fill",locator:{label:"Name"},value:"live Șță 😀"},
        {action:"click",locator:{role:"button",name:"Save"}},
        {action:"snapshot"},{action:"evaluate",expression:"document.querySelector('output').textContent"},
        {action:"cdp",scope:"browser",method:"Browser.getVersion"},{action:"screenshot"},
      ]});
      assert.equal(body.executed,7);assert.equal(body.results[4].result.value,"live Șță 😀");
      assert((raw.content as any[]).some(x=>x.type==="image"&&x.mimeType==="image/png"));
      const abort=new AbortController();
      const waiting=client.callTool({name:"browser_action",arguments:{device,sessionId:session.sessionId,actions:[{action:"click",locator:{text:"missing"},timeoutMs:30000},{action:"evaluate",expression:"globalThis.mustNotRun=true"}]}},undefined,{signal:abort.signal,timeout:35000});
      const observed=waiting.then(()=>false,()=>true);await new Promise(r=>setTimeout(r,250));abort.abort();assert(await observed);
      const before=performance.now(),next=await call(client,"browser_action",{device,sessionId:session.sessionId,timeoutMs:4000,actions:[{action:"evaluate",expression:"globalThis.mustNotRun??false"}]});
      assert.equal(next.body.results[0].result.value,false);
      result.push({device,dom:true,unicode:true,snapshot:true,cdp:true,screenshot:true,cancellation:true,nextCallMs:Math.round(performance.now()-before)});
    }finally{await call(client,"browser_session",{device,action:"close",sessionId:session.sessionId})}
  }
  const stdio=new Client({name:"stdio-release-validation",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve("apps/mcp-server/src/stdio.ts")],env:Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>p[1]!==undefined)),stderr:"pipe"});
  let stderr="";transport.stderr?.on("data",chunk=>{stderr+=chunk.toString()});
  try{
    await stdio.connect(transport);assert.equal((await stdio.listTools()).tools.length,listed.tools.length);
    for(const device of ["server","standby","Gaming"])for(const context of ["user","system"]){
      const {body}=await call(stdio,"exec",{device,context,command:"echo RCMCP_STDIO_LIVE"});assert.equal(body.code,0);assert(body.stdout.includes("RCMCP_STDIO_LIVE"));
    }
  }finally{await stdio.close()}
  assert.equal(stderr,"");
  console.log(JSON.stringify({tools:listed.tools.length,sha:expected,browser:result,stdioContexts:6},null,2));
}finally{await closeMcpValidation(client,transport)}
