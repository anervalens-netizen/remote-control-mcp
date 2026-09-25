import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDesktopRoutes } from "../apps/agent/src/desktop-routes.ts";
import { registerDesktopTools } from "../apps/mcp-server/src/desktop-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { closeDesktopHelper, desktopMonitors, desktopWindows } from "../apps/agent/src/desktop.ts";

it.skipIf(process.platform !== "win32" || process.env.RCMCP_TEST_INTERACTIVE === "0").each(["persistent", "oneshot"])("enumerates windows and operates real UIA controls in %s mode", async mode => {
  const previous=process.env.RCMCP_DESKTOP_HELPER; process.env.RCMCP_DESKTOP_HELPER=mode === "oneshot" ? "0" : "1";
  const root=await mkdtemp(path.join(os.tmpdir(),"rcmcp-uia-"));
  const script=String.raw`
Add-Type -AssemblyName System.Windows.Forms
$main=[Windows.Forms.Form]::new();$main.Text='RCMCP UIA primary';$main.Width=320;$main.Height=280
$second=[Windows.Forms.Form]::new();$second.Text='RCMCP UIA secondary';$second.Width=200;$second.Height=100
$hidden=[Windows.Forms.Form]::new();$hidden.Text='RCMCP UIA hidden'
$box=[Windows.Forms.TextBox]::new();$box.AccessibleName='RCMCP input';$box.Text='before';$box.Top=10;$box.Width=240
$button=[Windows.Forms.Button]::new();$button.AccessibleName='RCMCP button';$button.Text='Press';$button.Top=45
$button.Add_Click({[IO.File]::WriteAllText((Join-Path $env:RCMCP_UIA_FIXTURE 'clicked.txt'),'clicked')})
$check=[Windows.Forms.CheckBox]::new();$check.AccessibleName='RCMCP check';$check.Text='Check';$check.Top=80
$rich=[Windows.Forms.RichTextBox]::new();$rich.AccessibleName='RCMCP text';$rich.Text='Text pattern sample';$rich.Top=115;$rich.Width=240;$rich.Height=60
$main.Controls.AddRange(@($box,$button,$check,$rich))
$main.Show();$second.Show();$hiddenHandle=$hidden.Handle
[IO.File]::WriteAllText((Join-Path $env:RCMCP_UIA_FIXTURE 'ready.json'),(@{pid=$PID;main=[int64]$main.Handle;second=[int64]$second.Handle;hidden=[int64]$hiddenHandle}|ConvertTo-Json -Compress))
[Windows.Forms.Application]::Run($main)
$second.Dispose();$hidden.Dispose()
`;
  const file=path.join(root,"fixture.ps1");await writeFile(file,script);
  const child=spawn("powershell.exe",["-NoLogo","-NoProfile","-Sta","-ExecutionPolicy","Bypass","-File",file],{env:{...process.env,RCMCP_UIA_FIXTURE:root},windowsHide:true,stdio:"ignore"});
  const agent=Fastify();registerDesktopRoutes(agent);
  const server=new McpServer({name:"uia-native-test",version:"1"}),client=new Client({name:"test",version:"1"});
  const tool=async(name:string,input:Record<string,unknown>)=>{
    const result=await client.callTool({name,arguments:{device:"fixture",...input}});
    if(result.isError)throw new Error((result.content as Array<{text:string}>)[0]!.text);
    return JSON.parse((result.content as Array<{text:string}>)[0]!.text);
  };
  const uia=(input:Record<string,unknown>)=>tool("desktop_uia",input);
  try {
    const url=await agent.listen({host:"127.0.0.1",port:0});
    registerDesktopTools(server,new AgentClient([{name:"fixture",url,desktopUrl:url}]));
    const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
    let fixture: any;
    for(let i=0;i<100;i++){try{fixture=JSON.parse(await readFile(path.join(root,"ready.json"),"utf8"));break;}catch{}await new Promise(r=>setTimeout(r,100));}
    expect(fixture).toBeDefined();
    expect(Array.isArray(await desktopMonitors())).toBe(true);
    const windows=await desktopWindows({pid:fixture.pid});
    expect(windows.map((w:any)=>w.handle)).toEqual(expect.arrayContaining([fixture.main,fixture.second]));
    expect(windows.map((w:any)=>w.handle)).not.toContain(fixture.hidden);
    const hidden=await desktopWindows({pid:fixture.pid,includeHidden:true});
    expect(hidden.map((w:any)=>w.handle)).toContain(fixture.hidden);
    expect(await desktopWindows({pid:fixture.pid,title:"no such fixture title"})).toEqual([]);
    const desktop=await uia({depth:0,limit:1});
    closeDesktopHelper();
    expect(await uia({action:"inspect",elementId:desktop.elements[0].elementId})).toMatchObject({element:{elementId:desktop.elements[0].elementId}});
    const tree=await uia({handle:fixture.main,depth:5}) as any;
    expect(tree.errors).toEqual([]);
    const box=tree.elements.find((e:any)=>e.name==="RCMCP input");
    const button=tree.elements.find((e:any)=>e.name==="RCMCP button");
    const check=tree.elements.find((e:any)=>e.name==="RCMCP check");
    expect(box?.patterns).toContain("Value"); expect(button?.patterns).toContain("Invoke"); expect(check?.patterns).toContain("Toggle");
    const rich=tree.elements.find((e:any)=>e.name==="RCMCP text");
    expect(rich?.patterns).toContain("Text");
    const textRange=await uia({action:"pattern",elementId:rich.elementId,pattern:"Text",method:"RangeFromPoint",arguments:[{x:rich.rect.x+5,y:rich.rect.y+5}]});
    expect(textRange.result).toMatchObject({type:"TextPatternRange",enclosingElementId:rich.elementId});
    expect(typeof textRange.result.text).toBe("string");
    const selection=await uia({action:"pattern",elementId:rich.elementId,pattern:"Text",method:"GetSelection",arguments:[]});
    expect(Array.isArray(selection.result)).toBe(true);
    const first=await uia({handle:fixture.main,limit:1,depth:5}) as any;
    const second=await uia({handle:fixture.main,limit:1,depth:5,offset:first.nextOffset}) as any;
    expect(first.elements[0].elementId).not.toBe(second.elements[0].elementId);
    const batch=await tool("desktop_batch",{actions:[{kind:"uia",action:"setValue",elementId:box.elementId,value:"after 😀"},{kind:"uia",action:"inspect",elementId:box.elementId}]});
    expect(batch).toMatchObject({ok:true,executed:2});
    expect(await uia({action:"inspect",elementId:box.elementId})).toMatchObject({element:{value:"after 😀"}});
    await uia({action:"invoke",elementId:button.elementId});
    for(let i=0;i<30;i++){try{if(await readFile(path.join(root,"clicked.txt"),"utf8")==="clicked")break;}catch{}await new Promise(r=>setTimeout(r,50));}
    expect(await readFile(path.join(root,"clicked.txt"),"utf8")).toBe("clicked");
    await uia({action:"pattern",elementId:check.elementId,pattern:"Toggle",method:"Toggle",arguments:[]});
    const inspected=await uia({action:"inspect",elementId:check.elementId}) as any;
    expect(inspected.element.patternDetails.find((p:any)=>p.name==="Toggle").state.ToggleState).toBe("On");
    closeDesktopHelper();
    expect(await uia({action:"inspect",elementId:box.elementId})).toMatchObject({element:{value:"after 😀"}});
    child.kill();await new Promise<void>(resolve=>child.once("close",()=>resolve()));
    await expect(uia({action:"inspect",elementId:box.elementId})).rejects.toThrow(/Stale|unavailable/);
  } finally {
    await client.close();await server.close();agent.server.closeAllConnections();await agent.close();
    closeDesktopHelper();
    if(previous===undefined)delete process.env.RCMCP_DESKTOP_HELPER;else process.env.RCMCP_DESKTOP_HELPER=previous;
    if(child.exitCode===null && child.signalCode===null){child.kill();await new Promise<void>(resolve=>child.once("close",()=>resolve()));}
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
},60000);
