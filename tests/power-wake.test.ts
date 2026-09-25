import { expect,it } from "vitest";
import { createSocket } from "node:dgram";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Fastify from "fastify";
import { powerPlan,hostPower } from "../apps/agent/src/power.ts";
import { wakeSchema } from "../packages/protocol/src/power.ts";
import { magicPacket,sendWake } from "../packages/shared/src/wake.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { registerHostTools } from "../apps/mcp-server/src/host-tools.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { jobStart } from "../apps/agent/src/jobs.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
it("plans explicit delays and force semantics without implicit Windows forced shutdown",()=>{
  const win=powerPlan({action:"reboot",delaySeconds:20},"win32");
  expect(win.command).toContain("Start-Sleep -Seconds 20");expect(win.command).toContain("/r /t 0");expect(win.command).not.toContain("/f");expect(win.forceApplied).toBe(false);
  expect(powerPlan({action:"shutdown",force:true},"win32").command).toContain("/f");
  expect(powerPlan({action:"shutdown",force:true},"linux").command).toContain("systemctl poweroff --force");
  const sleep=powerPlan({action:"sleep",delaySeconds:9000},"win32");expect(sleep.command).toContain("Start-Sleep -Seconds 9000");
  const script=Buffer.from(sleep.command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1]!,"base64").toString("utf16le");expect(script).toContain("PowerState]::Suspend");expect(script).not.toContain("rundll32");
});
it("reports only durable submission and propagates failed starts without false success",async()=>{
  const failure:typeof jobStart=async()=>{throw new Error("spawn failed")};
  expect(await hostPower({action:"shutdown",dryRun:true},failure)).toMatchObject({scheduled:false,dryRun:true,powerStateVerified:false});
  await expect(hostPower({action:"shutdown"},failure)).rejects.toThrow("spawn failed");
  let received="";
  const fake=(async(input:{command:string})=>{received=input.command;return {id:"fixture-job"}}) as typeof jobStart;
  expect(await hostPower({action:"reboot"},fake)).toMatchObject({scheduled:true,submissionVerified:true,powerStateVerified:false,job:{id:"fixture-job"}});
  expect(received).toBe(powerPlan({action:"reboot"}).command);
});
it("validates MAC bytes and reports socket bind failure without crashing",async()=>{
  expect(magicPacket("12:34:56:78:9a:bc")).toEqual(magicPacket("1234.5678.9abc"));
  expect(()=>magicPacket("zz12:34:56:78:9a:bc")).toThrow("MAC");
  await expect(sendWake(wakeSchema.parse({mac:"12:34:56:78:9a:bc",localAddress:"203.0.113.254",broadcast:"127.0.0.1"}))).rejects.toThrow();
  const controller=new AbortController();controller.abort(new Error("cancelled"));
  await expect(sendWake(wakeSchema.parse({mac:"12:34:56:78:9a:bc"}),controller.signal)).rejects.toThrow("cancelled");
});
it("routes dry-run power and loopback-only WoL relay through actual MCP and HTTP",async()=>{
  const udp=createSocket("udp4");await new Promise<void>(resolve=>udp.bind(0,"127.0.0.1",resolve));const packets:Buffer[]=[];
  const received=new Promise<void>(resolve=>udp.on("message",packet=>{packets.push(packet);if(packets.length===2)resolve()}));
  const app=Fastify();app.get("/v1/info",async()=>({platform:process.platform}));registerExtraRoutes(app);const url=await app.listen({host:"127.0.0.1",port:0});
  const server=new McpServer({name:"power-test",version:"1"}),client=new Client({name:"test",version:"1"});
  registerHostTools(server,new AgentClient([{name:"fixture",url,userUrl:url}]));
  const [st,ct]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(st),client.connect(ct)]);
  const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});expect(result.isError).not.toBe(true);return JSON.parse((result.content as Array<{text:string}>)[0]!.text)};
  try{
    for(const action of ["reboot","shutdown","sleep","hibernate","lock"]){
      const preview=await call("host_power",{device:"fixture",action,dryRun:true});
      expect(preview).toMatchObject({scheduled:false,powerStateVerified:false,context:action==="lock"&&process.platform==="win32"?"user":"system"});
    }
    const result=await call("wake_on_lan",{device:"fixture",mac:"12:34:56:78:9a:bc",broadcast:"127.0.0.1",port:udp.address().port,repeat:2});
    expect(result).toMatchObject({sent:true,wakeVerified:false,sentPackets:2,bytesPerPacket:102});
    await received;for(const packet of packets)expect(packet).toEqual(magicPacket("12:34:56:78:9a:bc"));
  }finally{await client.close();await server.close();app.server.closeAllConnections();await app.close();udp.close()}
},15000);
it.skipIf(process.platform!=="win32")("parses Windows power plans without executing any power action",async()=>{
  const plans=["reboot","shutdown","sleep","hibernate","lock"].map(action=>powerPlan({action:action as any,delaySeconds:3},"win32").command);
  const script="$commands=$env:RCMCP_POWER_PLANS|ConvertFrom-Json; foreach($command in $commands){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($command,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)}}; Add-Type -AssemblyName System.Windows.Forms; if(-not [Windows.Forms.Application].GetMethod('SetSuspendState')){throw 'Suspend API missing'}; 'parsed'";
  const result=await promisify(execFile)("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{env:{...process.env,RCMCP_POWER_PLANS:JSON.stringify(plans)},windowsHide:true});
  expect(result.stdout.trim()).toBe("parsed");
});

it("never sends a power preview to a legacy agent that ignores dryRun",async()=>{
  let legacyCalls=0;const app=Fastify();
  app.post("/v1/power",async()=>{legacyCalls++;return {scheduled:true}});
  const url=await app.listen({host:"127.0.0.1",port:0});
  try{
    const client=new AgentClient([{name:"legacy",url}]);
    await expect(client.hostPower("legacy",{action:"shutdown",dryRun:true})).rejects.toMatchObject({status:404});
    expect(legacyCalls).toBe(0);
  }finally{app.server.closeAllConnections();await app.close()}
});
