import { closeMcpValidation } from "./mcp-validation-client.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

process.loadEnvFile(".env.mcp");
const expected = process.argv[2];
assert(expected, "Pass expected runtime SHA");
const agent = new AgentClient();
const client = new Client({ name: "editing-release-validation", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(process.argv[3] ?? process.env.RCMCP_VALIDATION_URL ?? "http://127.0.0.1:45230/mcp"), {
  requestInit: { headers: { Authorization: "Bearer " + process.env.RCMCP_MCP_TOKEN } },
});
await client.connect(transport);
const json = (result: any) => {
  assert(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content.find((c: any) => c.type === "text").text);
};
async function shell(device: string, context: "system" | "user", code: string) {
  const encoded = Buffer.from(code).toString("base64");
  const result = await agent.exec(device, { command: `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`, timeoutMs: 20000, maxOutputBytes: 8192 }, context) as any;
  assert.equal(result.code, 0, JSON.stringify(result));
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
const results: unknown[] = [];
try {
  const tools = await client.listTools();
  for (const name of ["repo_checkpoint", "repo_apply_patch", "fs_edit"]) assert(tools.tools.some(t => t.name === name));
  for (const device of ["server", "standby", "Gaming"]) for (const context of ["user", "system"] as const) {
    const info = await agent.info(device, context) as any;
    assert.equal(info.runtime.sha, expected); assert.equal(info.runtime.ready, true);
    const fixture = await shell(device, context, `
      const fs=require('node:fs'),os=require('node:os'),p=require('node:path'),cp=require('node:child_process');
      const dir=fs.mkdtempSync(p.join(os.tmpdir(),'rcmcp-live-edit-'));
      const git=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
      git('init');git('config','user.name','RCMCP validation');git('config','user.email','validation@example.invalid');
      git('config','core.autocrlf','false');git('config','commit.gpgsign','false');
      for(const name of ['a.txt','b.txt'])fs.writeFileSync(p.join(dir,name),'before\\n');
      git('add','.');git('commit','-m','fixture');
      fs.writeFileSync(p.join(dir,'b.txt'),'staged\\n');git('add','b.txt');fs.writeFileSync(p.join(dir,'b.txt'),'unstaged\\n');
      fs.writeFileSync(p.join(dir,'nou ü.txt'),'new\\n');console.log(JSON.stringify({dir}));
    `);
    const call = async (name: string, input: Record<string, unknown>) => json(await client.callTool({ name, arguments: { device, context, ...input } }, undefined, { timeout: 30000 }));
    try {
      const file = device === "Gaming" ? path.win32.join(fixture.dir, "a.txt") : path.posix.join(fixture.dir, "a.txt");
      const edit = await call("fs_edit", { path: file, edits: [{ oldText: "before", newText: "edited ș七" }] });
      assert.equal(edit.verified, true);
      const preview = await call("repo_checkpoint", { path: fixture.dir, paths: ["a.txt", "nou ü.txt"], dryRun: true });
      assert.equal(preview.wouldCreate, true); assert.equal(preview.changes.length, 2);
      const checkpoint = await call("repo_checkpoint", { path: fixture.dir, paths: ["a.txt", "nou ü.txt"], message: "selected live fixture" });
      assert.equal(checkpoint.created, true); assert.equal(checkpoint.indexUpdated, true);
      const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-edited ș七\n+patched ș七\n";
      const check = await call("repo_apply_patch", { path: fixture.dir, patch, target: "both", checkOnly: true });
      assert.equal(check.applied, false);
      const applied = await call("repo_apply_patch", { path: fixture.dir, patch, target: "both" });
      assert.equal(applied.applied, true);
      const verified = await shell(device, context, `
        const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process'),dir=${JSON.stringify(fixture.dir)};
        const git=(...args)=>cp.execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['pipe','pipe','pipe']});
        console.log(JSON.stringify({headA:git('show','HEAD:a.txt'),headB:git('show','HEAD:b.txt'),indexB:git('show',':b.txt'),workB:fs.readFileSync(p.join(dir,'b.txt'),'utf8'),indexA:git('show',':a.txt'),workA:fs.readFileSync(p.join(dir,'a.txt'),'utf8')}));
      `);
      assert.deepEqual(verified, { headA: "edited ș七\n", headB: "before\n", indexB: "staged\n", workB: "unstaged\n", indexA: "patched ș七\n", workA: "patched ș七\n" });
      results.push({ device, context, runtimeSha: info.runtime.sha, user: info.runtime.user, checkpoint: checkpoint.head, stagingPreserved: true, editVerified: true, patchVerified: true });
    } finally {
      await shell(device, context, `require('node:fs').rmSync(${JSON.stringify(fixture.dir)},{recursive:true,force:true,maxRetries:10,retryDelay:100});`);
    }
  }
  console.log(JSON.stringify({ tools: tools.tools.length, results, fixturesRemoved: true }, null, 2));
} finally {
  await closeMcpValidation(client,transport);
}
