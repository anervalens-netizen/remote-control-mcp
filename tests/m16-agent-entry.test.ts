import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { transferFile } from "../apps/mcp-server/src/transfer-tools.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("starts the actual agent and serves repeated HEAD/GET without duplicate routes or leaked source handles", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"m16-agent-entry-"));
  const input=path.join(root,"source.bin"); await writeFile(input,"SOURCE Șță");
  const reservation=createServer(); await new Promise<void>(resolve=>reservation.listen(0,"127.0.0.1",resolve));
  const port=(reservation.address() as {port:number}).port; await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const env: NodeJS.ProcessEnv={...process.env,RCMCP_AGENT_HOST:"127.0.0.1",RCMCP_AGENT_PORT:String(port),RCMCP_STATE_DIR:path.join(root,"state"),RCMCP_AGENT_TOKEN:"fixture-agent-health",RCMCP_ALLOW_UNAUTHENTICATED:"1",RCMCP_DESKTOP_ENABLED:"0"};
  delete env.RCMCP_BODY_LIMIT_BYTES;
  const child=spawn(process.execPath,[path.resolve("apps/agent/src/index.ts")],{env,stdio:["ignore","pipe","pipe"],windowsHide:true});
  const closed=once(child,"close"); let diagnostics="";
  child.stdout.on("data",chunk=>{diagnostics+=chunk.toString()});child.stderr.on("data",chunk=>{diagnostics+=chunk.toString()});
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    const deadline=Date.now()+10000;
    while(Date.now()<deadline && child.exitCode===null){
      try {ready=(await fetch(base+"/health")).ok;if(ready)break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    expect(ready,diagnostics).toBe(true);
    expect(await fetch(base+"/health").then(r=>r.json())).toEqual({ok:true});
    expect((await fetch(base+"/health/details")).status).toBe(401);
    const health=await fetch(base+"/health",{headers:{authorization:"Bearer fixture-agent-health"}}).then(response=>response.json()) as {runtime:{maxBodyBytes:number|null}};
    expect(health.runtime.maxBodyBytes).toBeNull();

    const largeBytes=17*1024*1024;
    const largePath=path.join(root,"large-request.bin");
    const largeResponse=await fetch(base+"/v1/fs/write",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({path:largePath,data:"x".repeat(largeBytes)}),
    });
    expect(largeResponse.status,await largeResponse.text()).toBe(200);
    expect((await stat(largePath)).size).toBe(largeBytes);

    const invalidPath=path.join(root,"invalid-base64.bin");
    await writeFile(invalidPath,"before");
    const invalidBase64=await fetch(base+"/v1/fs/write",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({path:invalidPath,data:"!!!",encoding:"base64"}),
    });
    expect(invalidBase64.status).toBe(400);
    expect(await readFile(invalidPath,"utf8")).toBe("before");

    const fdPath=`/proc/${child.pid}/fd`;
    const count=async()=>process.platform==="linux"?(await readdir(fdPath)).length:0;
    const before=await count();
    const url=base+"/v1/fs/raw?path="+encodeURIComponent(input);
    for(let i=0;i<12;i++){
      const head=await fetch(url,{method:"HEAD"});expect(head.status).toBe(200);expect(await head.text()).toBe("");expect(head.headers.get("x-rcmcp-sha256")).toMatch(/^[a-f0-9]{64}$/);
      const get=await fetch(url);expect(get.status).toBe(200);expect(await get.text()).toBe("SOURCE Șță");
      expect(get.headers.get("x-rcmcp-sha256")).toBe(head.headers.get("x-rcmcp-sha256"));
    }
    const destination=path.join(root,"three-hour-transfer.bin");
    const transfer=await fetch(base+"/v1/fs/transfer-from",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({sourceBase:base,sourcePath:input,destinationPath:destination,timeoutMs:3*60*60*1000})});
    expect(transfer.status).toBe(200);
    expect(await transfer.json()).toMatchObject({sourceStableVerified:true,sourceVerification:"hash-and-final-confirmation"});
    expect(await readFile(destination,"utf8")).toBe("SOURCE Șță");
    const relayDestination=path.join(root,"relay-overwrite.bin");
    await writeFile(relayDestination,"old");
    if(process.platform!=="win32") { await chmod(input,0o755); await chmod(relayDestination,0o640); }
    const client=new AgentClient([{name:"fixture",url:base}]);
    const relay=await transferFile(client,{sourceDevice:"fixture",sourcePath:input,destinationDevice:"fixture",destinationPath:relayDestination,chunkBytes:4});
    expect(relay).toMatchObject({atomic:true,transport:"relay-base64",metadataPreserved:true,ownershipImported:false});
    expect(await readFile(relayDestination,"utf8")).toBe("SOURCE Șță");
    if(process.platform!=="win32") expect((await stat(relayDestination)).mode & 0o777).toBe(0o640);
    const copy=await client.fsManage("fixture",{operation:"copy",path:input,destination:relayDestination,force:false});
    expect(copy).toMatchObject({outcome:"skipped",copied:0,skipped:1,reason:"destination_exists"});
    const malformed=await fetch(base+"/v1/fs/manage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operation:"transfer-finalize",path:input})});
    expect(malformed.status).toBe(400);
    await new Promise(resolve=>setTimeout(resolve,100));
    if(process.platform==="linux")expect(await count()).toBeLessThanOrEqual(before+8);
  } finally {
    child.kill(); await closed;
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
},30000);
