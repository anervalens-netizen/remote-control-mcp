import { createServer, type Server } from "node:http";
import { mkdtemp, link, writeFile, readFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { readToolRegistry, installToolRegistry } from "../apps/mcp-server/src/sdk-tool-registry.ts";
import { fsManage } from "../apps/agent/src/filesystem.ts";
const servers: Server[] = [], roots: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function listen(server: Server) {
  servers.push(server); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
describe("adversarial remediation contracts", () => {
  it.each([301,302,303,307,308])("does not forward an RPC after HTTP %s", async (status) => {
    let targetCalls = 0, originCalls = 0;
    const target = await listen(createServer((req,res) => { req.resume(); targetCalls++; res.end('{}'); }));
    const origin = await listen(createServer((req,res) => { req.resume(); originCalls++; res.writeHead(status,{location:target+'/v1/exec'}).end(); }));
    const client = new AgentClient([{name:'fixture',url:origin}], 'synthetic-token', 1000);
    await expect(client.requestRoute('fixture','/v1/exec',{command:'never-executed'})).rejects.toThrow();
    expect(originCalls).toBe(1); expect(targetCalls).toBe(0);
  });
  it("does not replay an ordinary upstream error", async () => {
    let calls=0;const origin=await listen(createServer((req,res)=>{req.resume();calls++;res.writeHead(500).end('fixture error');}));
    await expect(new AgentClient([{name:'fixture',url:origin}]).requestRoute('fixture','/v1/exec',{command:'unused'})).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("exposes minimal unauthenticated health and protects detailed diagnostics", async () => {
    const origin=await listen(createMcpHttpServer(new AgentClient([{name:'private-fixture',url:'http://127.0.0.1:1'}]),{token:'fixture-token'}));
    const bare=await (await fetch(origin+'/health')).json();
    expect(bare).toEqual({ok:true,ready:true,service:'remote-control-mcp'});
    expect((await fetch(origin+'/health/details')).status).toBe(401);
    for(const route of ['/health','/health/details']) {
      const response=await fetch(origin+route,{headers:{authorization:'Bearer fixture-token'}});
      expect(response.status).toBe(200);expect(await response.json()).toMatchObject({runtime:{pid:process.pid},devices:[{name:'private-fixture'}]});
    }
    expect((await fetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(401);
  });
  it("does not expose diagnostics in explicitly unauthenticated MCP mode", async () => {
    const origin=await listen(createMcpHttpServer(new AgentClient([])));
    expect(await (await fetch(origin+'/health')).json()).toEqual({ok:true,ready:true,service:'remote-control-mcp'});
    expect((await fetch(origin+'/health/details')).status).toBe(401);
  });
  it("reports same-inode move as a no-op and preserves both names", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'same-inode-'));roots.push(root);
    const source=path.join(root,'source'),destination=path.join(root,'destination');await writeFile(source,'fixture');await link(source,destination);
    expect((await lstat(source)).ino).toBe((await lstat(destination)).ino);
    expect(await fsManage({operation:'move',path:source,destination,force:true})).toMatchObject({ok:true,sourceRemoved:false,outcome:'same_file_noop'});
    expect(await readFile(source,'utf8')).toBe('fixture');expect(await readFile(destination,'utf8')).toBe('fixture');
    await expect(fsManage({operation:'move',path:source,destination,force:false})).rejects.toMatchObject({code:'EEXIST'});
  });
  it("isolates the SDK compatibility surface and rejects incompatible implementations", () => {
    const server=new McpServer({name:'fixture',version:'1'});
    const registry=readToolRegistry(server);expect(registry).toBeDefined();
    installToolRegistry(server,registry);expect(readToolRegistry(server)).toBe(registry);
    expect(()=>readToolRegistry({} as McpServer)).toThrow('incompatible');
    expect(()=>installToolRegistry({} as McpServer,registry)).toThrow('incompatible');
  });
});
