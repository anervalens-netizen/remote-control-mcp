import { closeMcpValidation } from "./mcp-validation-client.ts";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
process.loadEnvFile(".env.mcp");
const expected = process.argv[2]; assert(expected, "Pass expected runtime SHA");
const agent = new AgentClient();
const client = new Client({ name: "runner-release-validation", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(process.env.RCMCP_VALIDATION_URL ?? "http://127.0.0.1:45230/mcp"), {
  requestInit: { headers: { Authorization: "Bearer " + process.env.RCMCP_MCP_TOKEN } },
});
await client.connect(transport);
async function tool(name: string, args: Record<string, unknown>, allowFailure = false) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
  if (!allowFailure) assert(!result.isError, JSON.stringify(result));
  return { failed: result.isError === true, body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) };
}
async function shell(device: string, context: "user" | "system", code: string) {
  const encoded = Buffer.from(code).toString("base64");
  const result = await agent.exec(device, { command: "node -e \"eval(Buffer.from('" + encoded + "','base64').toString('utf8'))\"", maxOutputBytes:8192 }, context);
  assert.equal(result.code, 0, JSON.stringify(result));
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const results: unknown[] = [];
try {
  const listed = await client.listTools();
  for (const name of ["project_run", "deploy_run", "job_wait", "job_output_since"]) assert(listed.tools.some(t => t.name === name));
  for (const device of ["server", "standby", "Gaming"]) for (const context of ["user", "system"] as const) {
    const info = await agent.info(device, context) as any;
    assert.equal(info.runtime.sha, expected);
    const fixture = await shell(device, context, "const fs=require('node:fs'),os=require('node:os'),p=require('node:path');const dir=fs.mkdtempSync(p.join(os.tmpdir(),'rcmcp-run-live-'));fs.writeFileSync(p.join(dir,'args.cjs'),'process.stdout.write(JSON.stringify({args:process.argv.slice(2),value:process.env.RCMCP_VALIDATE}));process.exitCode=17;');console.log(JSON.stringify({dir,node:process.execPath,script:p.join(dir,'args.cjs')}));");
    const common = { device, context }, ids: string[] = [], literal = ["two words", "", 'double"quote', "semi;colon", "$literal", "😀"];
    try {
      const args = { ...common, path: fixture.dir, executable: fixture.node, args: [fixture.script, ...literal], env: { RCMCP_VALIDATE: "literal-env" } };
      const sync = await tool("project_run", { ...args, mode:"exec" }, true);
      assert(sync.failed); assert.equal(sync.body.result.code,17);
      assert.deepEqual(JSON.parse(sync.body.result.stdout),{args:literal,value:"literal-env"});
      const async = await tool("project_run", args); ids.push(async.body.result.id);
      const completed = await tool("job_wait",{...common,id:ids[0],waitMs:15000,maxBytes:7});
      assert.equal(completed.body.exitCode,17);
      let page=completed.body, output=page.stdout.data;
      while (!page.outputComplete) { page=(await tool("job_output_since",{...common,id:ids[0],cursor:page.cursor,maxBytes:7})).body; output+=page.stdout.data; }
      assert.deepEqual(JSON.parse(output),{args:literal,value:"literal-env"});
      const deploy=await tool("deploy_run",{...common,cwd:fixture.dir,prepare:"echo PREPARE",apply:"exit 23",verify:"echo MUST_NOT_RUN",recover:"echo RECOVER"});
      ids.push(deploy.body.job.id);
      const done=(await tool("job_wait",{...common,id:deploy.body.job.id,waitMs:20000})).body;
      assert.equal(done.exitCode,23); assert.equal(done.progress.state,"recovered");
      assert.deepEqual(done.progress.phases.map((p:any)=>p.name),["prepare","apply","recover"]);
      assert(!done.stdout.data.includes("MUST_NOT_RUN"));
      results.push({device,context,sha:info.runtime.sha,argv:true,jobCursor:true,recovery:true});
    } finally {
      for(const id of ids) await agent.jobRemove(device,{id,force:true},context);
      await shell(device,context,"require('node:fs').rmSync("+JSON.stringify(fixture.dir)+",{recursive:true,force:true});");
    }
  }
  console.log(JSON.stringify({tools:listed.tools.length,results},null,2));
} finally { await closeMcpValidation(client,transport); }
