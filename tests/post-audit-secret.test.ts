import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import type {AgentClient} from '../apps/mcp-server/src/agent-client.ts';
import {fsManage,fsWrite} from '../apps/agent/src/filesystem.ts';
import {SecretStore} from '../apps/mcp-server/src/secret-store.ts';
import {registerSecretTools} from '../apps/mcp-server/src/secret-tools.ts';
import {installDefaultToolOutputContracts} from '../apps/mcp-server/src/tool-contract-defaults.ts';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(failure:'false'|'unknown'|'network'|'staging'|'none'){
 const root=await mkdtemp(path.join(os.tmpdir(),'activation-result-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));
 const store=new SecretStore(path.join(root,'broker'));await store.put('fixture',Buffer.from('PRIVATE_FIXTURE_PAYLOAD'));
 const destination=path.join(root,'installed');await writeFile(destination,'old');
 let deleted=0,moves=0;
 const agent={info:async()=>({platform:process.platform}),fsWrite:async(_name:string,input:Parameters<typeof fsWrite>[0])=>{if(failure==='staging')throw new Error('PRIVATE_FIXTURE_PAYLOAD');return fsWrite(input);},fsManage:async(_name:string,input:Parameters<typeof fsManage>[0])=>{
  if(input.operation==='move'){moves++;if(failure==='false')return {ok:false,sourceQuarantined:true,cleanupPath:input.path,sourceRemoved:false,unexpectedValue:'PRIVATE_FIXTURE_PAYLOAD'};if(failure==='unknown')return {};if(failure==='network')throw new Error('PRIVATE_FIXTURE_PAYLOAD');}
  if(input.operation==='delete')deleted++;
  return fsManage(input);
 }} as unknown as AgentClient;
 const server=new McpServer({name:'activation-fixture',version:'1'});installDefaultToolOutputContracts(server);registerSecretTools(server,agent,store);
 const client=new Client({name:'validation-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);await client.listTools();cleanups.push(async()=>{await client.close();await server.close();});
 return {root,destination,client,counts:()=>({deleted,moves})};
}
it.each(['false','unknown','network'] as const)('preserves recovery material and returns a typed SDK error for %s activation',async failure=>{
 const f=await fixture(failure);const result=await f.client.callTool({name:'secret_install',arguments:{alias:'fixture',device:'fixture',destination:f.destination,identity:'owner'}});
 expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({ok:false,code:failure==='false'?'secret_install_failed':'secret_install_uncertain',phase:'activation',recoveryRequired:true,destination:f.destination});
 expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_PAYLOAD');expect(f.counts()).toEqual({moves:1,deleted:0});expect(await readFile(f.destination,'utf8')).toBe('old');
 const temporary=(result.structuredContent as Record<string,unknown>).temporaryPath as string;expect(await readFile(temporary,'utf8')).toBe('PRIVATE_FIXTURE_PAYLOAD');
});
it('retains the same error and staging protection for secret template rendering',async()=>{
 const f=await fixture('false');const result=await f.client.callTool({name:'secret_template_render',arguments:{device:'fixture',destination:f.destination,template:'{{secret:fixture}}',identity:'owner'}});
 expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({code:'secret_install_failed',phase:'activation'});expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_PAYLOAD');expect(f.counts().deleted).toBe(0);
});
it('reports staging failure without launching activation or disclosing thrown payload text',async()=>{
 const f=await fixture('staging');const result=await f.client.callTool({name:'secret_install',arguments:{alias:'fixture',device:'fixture',destination:f.destination}});
 expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({code:'secret_install_failed',phase:'staging'});expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_PAYLOAD');expect(f.counts().moves).toBe(0);
});
it('installs successfully and leaves no staging file on the normal path',async()=>{
 const f=await fixture('none');const result=await f.client.callTool({name:'secret_install',arguments:{alias:'fixture',device:'fixture',destination:f.destination}});
 expect(result.isError).not.toBe(true);expect(await readFile(f.destination,'utf8')).toBe('PRIVATE_FIXTURE_PAYLOAD');expect((await readdir(f.root)).filter(name=>name.startsWith('.rcmcp-secret-'))).toEqual([]);expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_PAYLOAD');
});
