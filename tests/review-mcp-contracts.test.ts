import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, writeFile, link, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { AgentClient } from '../apps/mcp-server/src/agent-client.ts';
import { registerTools } from '../apps/mcp-server/src/all-tools.ts';
import { fsManage } from '../apps/agent/src/filesystem.ts';
const closers:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();});
async function harness(){
 const agent=Fastify();
 agent.post('/v1/fs/manage',async request=>fsManage(request.body as Parameters<typeof fsManage>[0]));
 agent.post('/v1/jobs/start',async(request,reply)=>{
  const input=request.body as {command:string};
  return reply.code(409).send({error:input.command==='conflict'?'job_start_conflict':'job_start_uncertain',message:'Synthetic keyed start rejected',jobId:'00000000-0000-4000-8000-000000000001',credentials:'must-not-leak'});
 });
 const url=await agent.listen({host:'127.0.0.1',port:0});closers.push(()=>agent.close());
 const server=new McpServer({name:'contract-fixture',version:'1'});
 registerTools(server,new AgentClient([{name:'fixture',url,userUrl:url}]));
 const client=new Client({name:'contract-client',version:'1'});
 const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
 closers.push(async()=>{await client.close();await server.close();});
 await client.listTools();return client;
}
it('validates a real same-inode no-op through the advertised MCP output schema',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'mcp-same-file-'));closers.push(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),destination=path.join(root,'destination');await writeFile(source,'same-file-fixture');await link(source,destination);
 const client=await harness();
 const result=await client.callTool({name:'fs_manage',arguments:{device:'fixture',identity:'owner',operation:'move',path:source,destination,force:true}});
 expect(result.isError).not.toBe(true);expect(result.structuredContent).toMatchObject({ok:true,outcome:'same_file_noop',sourceRemoved:false});
 expect(await readFile(source,'utf8')).toBe('same-file-fixture');expect(await readFile(destination,'utf8')).toBe('same-file-fixture');
});
it.each(['conflict','uncertain'])('preserves typed %s recovery identity through HTTP and MCP',async(command)=>{
 const client=await harness();
 const result=await client.callTool({name:'job_start',arguments:{device:'fixture',identity:'owner',command,idempotencyKey:'fixture-key'}});
 expect(result.isError).toBe(true);
 expect(result.structuredContent).toMatchObject({ok:false,status:409,code:'job_start_'+command,jobId:'00000000-0000-4000-8000-000000000001'});
 expect(JSON.stringify(result)).not.toContain('must-not-leak');
});
