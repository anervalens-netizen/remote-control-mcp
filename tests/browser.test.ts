import { afterEach,expect,it,vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BrowserManager } from "../apps/agent/src/browser.ts";
import { registerBrowserRoutes } from "../apps/agent/src/browser-routes.ts";
import { registerBrowserTools } from "../apps/mcp-server/src/browser-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
const executablePath=process.env.RCMCP_TEST_BROWSER??[chromium.executablePath(),"C:/Program Files/Google/Chrome/Application/chrome.exe","/usr/bin/chromium","/usr/bin/google-chrome"].find(p=>existsSync(p));
const native=it.skipIf(!executablePath),managers:BrowserManager[]=[];
afterEach(async()=>{await Promise.all(managers.splice(0).map(m=>m.close()))});
const html='<meta charset="UTF-8"><title>RCMCP browser fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'#name\').value">Save</button><output></output><label>Enabled<input type="checkbox"></label><select aria-label="Choice"><option>a</option><option>b</option></select><input type="file" aria-label="Upload"><iframe srcdoc="<button>Frame button</button>"></iframe>';
async function fixture(){
  const server=createServer((_req,res)=>{res.setHeader("content-type","text/html; charset=utf-8");res.end(html)});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const address=server.address() as {port:number};
  return {url:"http://127.0.0.1:"+address.port,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}};
}
native("routes real browser batches, DOM, native CDP and images through MCP",async()=>{
  const site=await fixture(),manager=new BrowserManager();managers.push(manager);
  const app=Fastify();registerBrowserRoutes(app,manager);const url=await app.listen({host:"127.0.0.1",port:0});
  const server=new McpServer({name:"browser-test",version:"1"}),client=new Client({name:"test",version:"1"});
  registerBrowserTools(server,new AgentClient([{name:"fixture",url,userUrl:url}]));
  const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const raw=await client.callTool({name,arguments:{device:"fixture",...args}});
    const payload=(raw.content as Array<{type:string;text?:string}>).find(item=>item.type==="text")?.text??"";
    try{return {raw,body:JSON.parse(payload)}}
    catch{throw new Error(`${name} returned ${raw.isError?"an MCP error":"non-JSON content"}: ${payload}`)}
  };
  const temp=await mkdtemp(path.join(os.tmpdir(),"rcmcp-browser-"));
  try{
    const {body:session}=await call("browser_session",{action:"start",executablePath,headless:true});
    expect(session.context).toBe("user");expect(session.pages).toHaveLength(1);
    const sessionId=session.sessionId,pageId=session.pages[0].pageId;
    const uploaded=path.join(temp,"upload.txt");await writeFile(uploaded,"fixture");
    const {body,raw}=await call("browser_action",{sessionId,pageId,actions:[
      {action:"goto",url:site.url},{action:"fill",locator:{label:"Name"},value:"Șță 😀"},
      {action:"click",locator:{role:"button",name:"Save"}},{action:"check",locator:{label:"Enabled"}},
      {action:"select",locator:{label:"Choice"},value:"b"},{action:"upload",locator:{label:"Upload"},paths:[uploaded]},
      {action:"click",locator:{frame:"iframe",role:"button",name:"Frame button"}},
      {action:"snapshot"},{action:"evaluate",expression:"({saved:document.querySelector('output').textContent,checked:document.querySelector('[type=checkbox]').checked,selected:document.querySelector('select').value,file:document.querySelector('[type=file]').files[0].name})"},
      {action:"cdp",method:"Browser.getVersion",scope:"browser"},{action:"screenshot"},
    ]});
    expect(body.ok).toBe(true);expect(body.executed).toBe(11);
    expect(raw.structuredContent).toMatchObject({executionId:body.executionId,status:"completed",context:"user"});
    const lookup=await call("browser_execution",{sessionId,executionId:body.executionId});
    expect(lookup.raw.structuredContent).toMatchObject({executions:[{executionId:body.executionId,executed:11}]});
    expect(body.results[7].result.text).toContain("Save");
    expect(body.results[8].result.value).toEqual({saved:"Șță 😀",checked:true,selected:"b",file:"upload.txt"});
    expect(body.results[9].result.product).toContain("Chrome");
    expect((raw.content as any[]).find(x=>x.type==="image").mimeType).toBe("image/png");
    const failure=await call("browser_action",{sessionId,actions:[{action:"click",locator:{text:"missing"},timeoutMs:100},{action:"evaluate",expression:"globalThis.shouldNotRun=true"}]});
    expect(failure.raw.isError).toBe(true);expect(failure.body.executed).toBe(1);
    const check=await call("browser_action",{sessionId,actions:[{action:"evaluate",expression:"globalThis.shouldNotRun??false"}]});
    expect(check.body.results[0].result.value).toBe(false);
    const interrupted=await call("browser_action",{sessionId,timeoutMs:150,actions:[
      {action:"evaluate",expression:"globalThis.auditCounter=1"},
      {action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>resolve(2),700))"},
    ]});
    expect(interrupted.raw.isError).toBe(true);
    expect(interrupted.raw.structuredContent).toMatchObject({context:"user",executionId:expect.any(String),executed:1,activeStepIndex:1,outcome:"outcome_unknown",interruption:"timeout",results:[{result:{value:1}}]});
    await call("browser_session",{action:"close",sessionId});expect((await call("browser_session",{action:"list"})).body.sessions).toEqual([]);
  }finally{await client.close();await server.close();app.server.closeAllConnections();await app.close();await site.close();await rm(temp,{recursive:true,force:true})}
},45000);
native("cancels a waiting click and skips cancelled queued mutations",async()=>{
  const manager=new BrowserManager();managers.push(manager);const site=await fixture();
  try{
    const session=await manager.session({action:"start",executablePath}) as any,sessionId=session.sessionId;
    await manager.actions({sessionId,actions:[{action:"goto",url:site.url}]});
    const controller=new AbortController();
    const waiting=manager.actions({sessionId,actions:[{action:"click",locator:{text:"Delayed"},timeoutMs:20000},{action:"evaluate",expression:"globalThis.late=true"}]},controller.signal);
    await new Promise(resolve=>setTimeout(resolve,150));
    const queuedController=new AbortController();
    const queued=manager.actions({sessionId,actions:[{action:"evaluate",expression:"globalThis.queued=true"}]},queuedController.signal);
    const checks=Promise.all([
      expect(waiting).resolves.toMatchObject({status:"interrupted",interruption:"cancelled",error:"stop"}),
      expect(queued).resolves.toMatchObject({status:"interrupted",interruption:"cancelled",error:"skip",executed:0,activeStepIndex:null,outcome:"not_started"}),
    ]);
    queuedController.abort(new Error("skip"));controller.abort(new Error("stop"));await checks;
    const probe=await manager.actions({sessionId,timeoutMs:3000,actions:[{action:"evaluate",expression:"({late:!!globalThis.late,queued:!!globalThis.queued})"}]}) as any;
    expect(probe.results[0].result.value).toEqual({late:false,queued:false});
  }finally{await site.close()}
},20000);
native("disconnects attached CDP sessions without closing their browser or pages",async()=>{
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,"127.0.0.1",r));
  const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const external=await chromium.launch({executablePath,headless:true,args:["--remote-debugging-port="+port]});
  const page=await external.newPage();await page.setContent("<title>External fixture</title>");
  const manager=new BrowserManager();managers.push(manager);
  try{
    const session=await manager.session({action:"connect",endpoint:"http://127.0.0.1:"+port}) as any;
    expect(session.owned).toBe(false);expect(session.pages).toHaveLength(1);
    await manager.session({action:"close",sessionId:session.sessionId});
    expect(external.isConnected()).toBe(true);expect(await page.title()).toBe("External fixture");
  }finally{await external.close()}
},20000);

native("bounds page evaluation without replaying or interleaving unfinished work",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const session=await manager.session({action:"start",executablePath}) as any,sessionId=session.sessionId;
  await expect(manager.actions({sessionId,actions:[
    {action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>{globalThis.slowDone=true;resolve(1)},600))",timeoutMs:100},
    {action:"evaluate",expression:"globalThis.mustNotRun=true"},
  ]})).resolves.toMatchObject({status:"interrupted",interruption:"timeout",activeStepIndex:0,outcome:"outcome_unknown",executed:0});
  expect((await manager.session({action:"status",sessionId}) as any).pending).toBe(1);
  const next=await manager.actions({sessionId,timeoutMs:3000,actions:[{action:"evaluate",expression:"({done:!!globalThis.slowDone,skipped:!globalThis.mustNotRun})"}]}) as any;
  expect(next.results[0].result.value).toEqual({done:true,skipped:true});
},15000);

native("reopens an explicit profile with saved browser state and releases its lock",async()=>{
  const launch=chromium.launchPersistentContext.bind(chromium);
  const mocked=vi.spyOn(chromium,"launchPersistentContext").mockImplementation(async(...args)=>{const context=await launch(...args);vi.spyOn(context,"browser").mockReturnValue(null);return context});
  const root=await mkdtemp(path.join(os.tmpdir(),"rcmcp-profile-")),site=await fixture();
  const manager=new BrowserManager();managers.push(manager);
  try{
    const first=await manager.session({action:"start",executablePath,userDataDir:root}) as any;
    const saved=await manager.actions({sessionId:first.sessionId,actions:[{action:"goto",url:site.url},{action:"evaluate",expression:"localStorage.setItem('rcmcp','persistent 😀')"}]}) as any;
    expect(saved.ok).toBe(true);
    await manager.session({action:"close",sessionId:first.sessionId});
    const second=await manager.session({action:"start",executablePath,userDataDir:root}) as any;
    const loaded=await manager.actions({sessionId:second.sessionId,actions:[{action:"goto",url:site.url},{action:"evaluate",expression:"localStorage.getItem('rcmcp')"},{action:"cdp",scope:"browser",method:"Browser.getVersion"}]}) as any;
    expect(loaded.ok).toBe(true);expect(loaded.results[1].result.value).toBe("persistent 😀");
    await manager.session({action:"close",sessionId:second.sessionId});
  }finally{mocked.mockRestore();await manager.close();await site.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
},20000);


native("preserves completed effects on overall timeout and offers receipt readback without replay",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const {sessionId}=await manager.session({action:"start",executablePath}) as any;
  const app=Fastify();registerBrowserRoutes(app,manager);
  try{
    const response=await app.inject({method:"POST",url:"/v1/browser/actions",payload:{sessionId,timeoutMs:150,actions:[
      {action:"evaluate",expression:"globalThis.counter=(globalThis.counter??0)+1"},
      {action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>{globalThis.finished=true;resolve(2)},700))"},
      {action:"evaluate",expression:"globalThis.counter++"},
    ]}});
    expect(response.statusCode).toBe(200);
    const receipt=response.json();
    expect(receipt).toMatchObject({executionId:expect.any(String),ok:false,executed:1,activeStepIndex:1,outcome:"outcome_unknown",interruption:"timeout",results:[{index:0,ok:true,result:{value:1}}]});
    expect((await manager.session({action:"status",sessionId}) as any).pending).toBe(1);
    const next=await manager.actions({sessionId,actions:[{action:"evaluate",expression:"({counter:globalThis.counter,finished:globalThis.finished})"}]}) as any;
    expect(next.results[0].result.value).toEqual({counter:1,finished:true});
    const readback=await app.inject({method:"POST",url:"/v1/browser/executions",payload:{sessionId,executionId:receipt.executionId}});
    expect(readback.json().executions[0]).toMatchObject({executed:2,activeStepIndex:null,outcome:"settled",status:"interrupted",results:[{ok:true,result:{value:1}},{ok:true,result:{value:2}}]});
    expect(receipt.results).toHaveLength(1); // Returned snapshots never mutate later.
  }finally{await app.close()}
},15000);

native("cancellation preserves completed effects while in-flight evaluation settles",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const {sessionId}=await manager.session({action:"start",executablePath}) as any;
  const controller=new AbortController();
  const running=manager.actions({sessionId,actions:[
    {action:"evaluate",expression:"globalThis.counter=1"},
    {action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>resolve(++globalThis.counter),700))"},
    {action:"evaluate",expression:"globalThis.counter=999"},
  ]},controller.signal);
  // Observe actual dispatch, avoiding cancellation before the fixture is in flight.
  while(manager.executions({sessionId}).executions[0]?.activeStepIndex!==1)await new Promise(r=>setTimeout(r,5));
  controller.abort(new Error("owner cancelled"));
  const receipt=await running as any;
  expect(receipt).toMatchObject({executed:1,activeStepIndex:1,outcome:"outcome_unknown",interruption:"cancelled",results:[{result:{value:1}}]});
  const probe=await manager.actions({sessionId,actions:[{action:"evaluate",expression:"globalThis.counter"}]}) as any;
  expect(probe.results[0].result.value).toBe(2);
},15000);

native("bounds retained receipts and keeps ordinary stopOnError=false sequencing",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const {sessionId}=await manager.session({action:"start",executablePath}) as any;
  const first=await manager.actions({sessionId,stopOnError:false,actions:[{action:"evaluate",expression:"throw new Error('fixture failure')"},{action:"evaluate",expression:"42"}]}) as any;
  expect(first).toMatchObject({status:"failed",executed:2,activeStepIndex:null,outcome:"settled",results:[{ok:false},{ok:true,result:{value:42}}]});
  for(let i=0;i<130;i++)await manager.actions({sessionId,actions:[{action:"pages"}]});
  expect(manager.executions({sessionId}).executions).toHaveLength(128);
  expect(manager.executions({sessionId,executionId:first.executionId}).executions).toEqual([]);
  const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+900001);
  try{expect(manager.executions({sessionId}).executions).toEqual([])}finally{clock.mockRestore()}
},15000);

native("returns not_started for queued deadlines and pre-aborted requests without replay",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const {sessionId}=await manager.session({action:"start",executablePath}) as any;
  const running=manager.actions({sessionId,actions:[{action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>resolve(1),500))"}]});
  const queued=await manager.actions({sessionId,timeoutMs:50,actions:[{action:"evaluate",expression:"globalThis.unexpected=true"}]}) as any;
  expect(queued).toMatchObject({status:"interrupted",interruption:"timeout",executed:0,activeStepIndex:null,outcome:"not_started"});
  const aborted=new AbortController();aborted.abort(new Error("pre-aborted"));
  expect(await manager.actions({sessionId,actions:[{action:"evaluate",expression:"globalThis.unexpected=true"}]},aborted.signal)).toMatchObject({interruption:"cancelled",executed:0,outcome:"not_started"});
  await running;
  const probe=await manager.actions({sessionId,actions:[{action:"evaluate",expression:"globalThis.unexpected??false"}]}) as any;
  expect(probe.results[0].result.value).toBe(false);
  expect(manager.executions({sessionId,executionId:queued.executionId}).executions[0]).toMatchObject({executed:0,outcome:"not_started"});
},15000);

native("retains cancellation receipts after a real HTTP disconnect",async()=>{
  const manager=new BrowserManager();managers.push(manager);
  const {sessionId}=await manager.session({action:"start",executablePath}) as any;
  const app=Fastify();registerBrowserRoutes(app,manager);
  const url=await app.listen({host:"127.0.0.1",port:0});
  const controller=new AbortController();
  try{
    const request=fetch(url+"/v1/browser/actions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId,actions:[
      {action:"evaluate",expression:"globalThis.counter=1"},
      {action:"evaluate",expression:"new Promise(resolve=>setTimeout(()=>resolve(++globalThis.counter),700))"},
      {action:"evaluate",expression:"globalThis.counter=999"},
    ]}),signal:controller.signal});
    const aborted=expect(request).rejects.toThrow();
    while(manager.executions({sessionId}).executions[0]?.activeStepIndex!==1)await new Promise(r=>setTimeout(r,5));
    controller.abort();await aborted;
    while(manager.executions({sessionId}).executions[0]?.status!=="interrupted")await new Promise(r=>setTimeout(r,5));
    const response=await fetch(url+"/v1/browser/executions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sessionId})});
    const lookup=await response.json() as any;
    expect(lookup.executions[0]).toMatchObject({executed:1,activeStepIndex:1,outcome:"outcome_unknown",interruption:"cancelled"});
    const probe=await manager.actions({sessionId,actions:[{action:"evaluate",expression:"globalThis.counter"}]}) as any;
    expect(probe.results[0].result.value).toBe(2);
  }finally{controller.abort();app.server.closeAllConnections();await app.close()}
},15000);
