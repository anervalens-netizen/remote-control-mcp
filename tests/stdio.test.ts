import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { expect,it } from "vitest";
import path from "node:path";
it("discovers the same tools over stdio and routes native requests without stdout noise",async()=>{
  const app=Fastify();app.post("/v1/exec",async request=>{
    const stdout=(request.body as any).command as string;
    return {
      code:0,
      signal:null,
      stdout,
      stderr:"",
      durationMs:1,
      timedOut:false,
      stdoutBytes:Buffer.byteLength(stdout),
      stderrBytes:0,
      stdoutTruncated:false,
      stderrTruncated:false,
    };
  });
  const url=await app.listen({host:"127.0.0.1",port:0}),client=new Client({name:"stdio-test",version:"1"});
  const androidState=await mkdtemp(path.join(os.tmpdir(),"rcmcp-stdio-android-"));
  const occupiedPort=Number(new URL(url).port);
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve("apps/mcp-server/src/stdio.ts")],env:{
    ...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>p[1]!==undefined)),
    RCMCP_DEVICES_JSON:JSON.stringify({devices:[{name:"fixture",url,userUrl:url}]}),
    // Deliberately point Android config at the already-occupied Fastify port.
    // A per-client stdio process must ignore it rather than bind/fail EADDRINUSE.
    RCMCP_ANDROID_CONFIG:JSON.stringify({host:"127.0.0.1",port:occupiedPort,stateDir:androidState,devices:[{name:"phone-example",token:"stdio-android-test-token-0123456789abcdef"}]}),
  },stderr:"pipe"});
  let stderr="";transport.stderr?.on("data",chunk=>{stderr+=chunk.toString()});
  try{
    await client.connect(transport);expect(client.getInstructions()).toContain("browser_session");expect(client.getInstructions()).toContain("job_wait");const listed=await client.listTools();
    for(const name of ["exec","project_run","job_wait","desktop_uia","browser_session","browser_action"])expect(listed.tools.some(t=>t.name===name)).toBe(true);
    for(const name of ["android_status","android_observe","android_action","android_command_status"])expect(listed.tools.some(t=>t.name===name)).toBe(false);
    const result=await client.callTool({name:"exec",arguments:{device:"fixture",context:"user",command:"literal Șță 😀\nnext"}});
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as Array<{text:string}>)[0]!.text).stdout).toBe("literal Șță 😀\nnext");
    expect(result.structuredContent).toMatchObject({ identity:"owner", context:"user" });
  }finally{await client.close();app.server.closeAllConnections();await app.close();await rm(androidState,{recursive:true,force:true})}
  expect(stderr).toBe("");
},15000);
