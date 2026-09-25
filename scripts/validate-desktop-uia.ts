import { closeMcpValidation } from "./mcp-validation-client.ts";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
process.loadEnvFile(".env.mcp");
const expected=process.argv[2];assert(expected,"Pass expected runtime SHA");
const agent=new AgentClient(),client=new Client({name:"desktop-release-validation",version:"1"});
const transport = new StreamableHTTPClientTransport(new URL(process.env.RCMCP_VALIDATION_URL ?? "http://127.0.0.1:45230/mcp"),{requestInit:{headers:{Authorization:"Bearer "+process.env.RCMCP_MCP_TOKEN}}});
await client.connect(transport);
async function tool(name:string,args:Record<string,unknown>){
  const r=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert(!r.isError,JSON.stringify(r));
  return JSON.parse((r.content as Array<{text:string}>)[0]!.text);
}
async function shell(code:string){
  const encoded=Buffer.from(code).toString("base64");
  const r=await agent.exec("Gaming",{command:"node -e \"eval(Buffer.from('"+encoded+"','base64').toString('utf8'))\"",timeoutMs:15000,maxOutputBytes:8192},"user");
  assert.equal(r.code,0,JSON.stringify(r));return r.stdout.trim()?JSON.parse(r.stdout):null;
}
const fixtureScript="\nAdd-Type -AssemblyName System.Windows.Forms\n$main=[Windows.Forms.Form]::new();$main.Text='RCMCP UIA primary';$main.Width=320;$main.Height=280\n$second=[Windows.Forms.Form]::new();$second.Text='RCMCP UIA secondary';$second.Width=200;$second.Height=100\n$hidden=[Windows.Forms.Form]::new();$hidden.Text='RCMCP UIA hidden'\n$box=[Windows.Forms.TextBox]::new();$box.AccessibleName='RCMCP input';$box.Text='before';$box.Top=10;$box.Width=240\n$button=[Windows.Forms.Button]::new();$button.AccessibleName='RCMCP button';$button.Text='Press';$button.Top=45\n$button.Add_Click({[IO.File]::WriteAllText((Join-Path $env:RCMCP_UIA_FIXTURE 'clicked.txt'),'clicked')})\n$check=[Windows.Forms.CheckBox]::new();$check.AccessibleName='RCMCP check';$check.Text='Check';$check.Top=80\n$rich=[Windows.Forms.RichTextBox]::new();$rich.AccessibleName='RCMCP text';$rich.Text='Text pattern sample';$rich.Top=115;$rich.Width=240;$rich.Height=60\n$main.Controls.AddRange(@($box,$button,$check,$rich))\n$main.Show();$second.Show();$hiddenHandle=$hidden.Handle\n[IO.File]::WriteAllText((Join-Path $env:RCMCP_UIA_FIXTURE 'ready.json'),(@{pid=$PID;main=[int64]$main.Handle;second=[int64]$second.Handle;hidden=[int64]$hiddenHandle}|ConvertTo-Json -Compress))\n[Windows.Forms.Application]::Run($main)\n$second.Dispose();$hidden.Dispose()\n";
let fixture:any,job:any;
try{
  const listed=await client.listTools();assert(listed.tools.some(t=>t.name==="desktop_uia"));
  const versions=[];
  for(const device of ["server","standby","Gaming"])for(const context of ["user","system"] as const){
    const info=await agent.info(device,context) as any;assert.equal(info.runtime.sha,expected);versions.push({device,context,sha:info.runtime.sha});
  }
  fixture=await shell("const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const dir=fs.mkdtempSync(p.join(os.tmpdir(),'rcmcp-ui-live-'));fs.writeFileSync(p.join(dir,'fixture.ps1'),"+JSON.stringify(fixtureScript)+");console.log(JSON.stringify({dir,script:p.join(dir,'fixture.ps1')}));");
  job=await tool("job_start",{device:"Gaming",context:"user",command:'powershell.exe -NoLogo -NoProfile -Sta -ExecutionPolicy Bypass -File "'+fixture.script+'"',cwd:fixture.dir,env:{RCMCP_UIA_FIXTURE:fixture.dir}});
  const ready=await shell("const fs=require('node:fs'),p=require('node:path');(async()=>{const file=p.join("+JSON.stringify(fixture.dir)+",'ready.json');for(let n=0;n<100;n++){if(fs.existsSync(file)){console.log(fs.readFileSync(file,'utf8'));return}await new Promise(r=>setTimeout(r,100));}throw Error('Fixture startup deadline');})();");
  const uia=(args:Record<string,unknown>)=>tool("desktop_uia",{device:"Gaming",...args});
  const windows=await tool("desktop_windows",{device:"Gaming",pid:ready.pid});assert(Array.isArray(windows));assert(windows.some((w:any)=>w.handle===ready.main));assert(windows.some((w:any)=>w.handle===ready.second));
  const hidden=await tool("desktop_windows",{device:"Gaming",pid:ready.pid,includeHidden:true});assert(hidden.some((w:any)=>w.handle===ready.hidden));
  const root=await uia({depth:0,limit:1});assert.equal(root.elements.length,1);
  assert.equal((await uia({action:"inspect",elementId:root.elements[0].elementId})).element.elementId,root.elements[0].elementId);
  const tree=await uia({handle:ready.main,depth:4});assert.deepEqual(tree.errors,[]);
  const box=tree.elements.find((e:any)=>e.name==="RCMCP input"),button=tree.elements.find((e:any)=>e.name==="RCMCP button"),rich=tree.elements.find((e:any)=>e.name==="RCMCP text");
  const batch=await tool("desktop_batch",{device:"Gaming",actions:[{kind:"uia",action:"setValue",elementId:box.elementId,value:"live 😀"},{kind:"uia",action:"inspect",elementId:box.elementId}]});assert.equal(batch.executed,2);
  assert.equal((await uia({action:"inspect",elementId:box.elementId})).element.value,"live 😀");
  await uia({action:"invoke",elementId:button.elementId});
  assert.equal(await shell("console.log(JSON.stringify(require('node:fs').readFileSync(require('node:path').join("+JSON.stringify(fixture.dir)+",'clicked.txt'),'utf8')));"),"clicked");
  const range=await uia({action:"pattern",elementId:rich.elementId,pattern:"Text",method:"RangeFromPoint",arguments:[{x:rich.rect.x+5,y:rich.rect.y+5}]});assert.equal(range.result.type,"TextPatternRange");
  for(const context of ["user","system"])for(const shell of ["cmd.exe","powershell.exe","cmd.exe"]){
    const terminal=await tool("pty_start",{device:"Gaming",context,shell});
    try{await tool("pty_input",{device:"Gaming",context,id:terminal.id,data:"echo RCMCP_PTY_LIVE\r"});await tool("pty_terminate",{device:"Gaming",context,id:terminal.id});}
    finally{await tool("pty_remove",{device:"Gaming",context,id:terminal.id,force:true});}
  }
  console.log(JSON.stringify({tools:listed.tools.length,versions,windows:true,rootReference:true,uiaBatch:true,invoke:true,pointArgument:true,ptyShutdowns:6},null,2));
}finally{
  if(job)await agent.jobRemove("Gaming",{id:job.id,force:true},"user");
  if(fixture)await shell("require('node:fs').rmSync("+JSON.stringify(fixture.dir)+",{recursive:true,force:true});");
  await closeMcpValidation(client,transport);
}
