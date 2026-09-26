import Fastify from 'fastify';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {mkdtemp,mkdir,symlink,writeFile,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {AgentClient} from '../apps/mcp-server/src/agent-client.ts';
import {registerTransferTools,syncDirectory} from '../apps/mcp-server/src/transfer-tools.ts';
import {installDefaultToolOutputContracts} from '../apps/mcp-server/src/tool-contract-defaults.ts';
import {overlappingPaths} from '../apps/mcp-server/src/directory-paths.ts';
import {fsManage,fsList,fsRead,fsWrite} from '../apps/agent/src/filesystem.ts';
import {registerFilesystemManageRoute} from '../apps/agent/src/filesystem-routes.ts';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(failRead=false,delayFirst=false){
 const root=await mkdtemp(path.join(os.tmpdir(),'sync-receipt-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));
 const source=path.join(root,'source'),destination=path.join(root,'destination');await mkdir(source);await writeFile(path.join(source,'01-good'),'first');await writeFile(path.join(source,'02-fail'),'second');await writeFile(path.join(source,'03-late'),'third');
 const agent=Fastify();registerFilesystemManageRoute(agent);
 agent.get('/v1/info',async()=>({platform:process.platform,hostname:'synthetic-one-host',runtime:{transferStagingVersion:1,pathResolutionVersion:1}}));
 agent.post('/v1/fs/list',async request=>(await fsList(request.body as {path:string})).sort((a,b)=>a.name.localeCompare(b.name)));
 const reads:string[]=[];
 agent.post('/v1/fs/read',async request=>{const input=request.body as Parameters<typeof fsRead>[0];reads.push(input.path);if(failRead&&input.path.endsWith('02-fail'))throw new Error('injected read failure');if(delayFirst&&input.path.endsWith('01-good'))await new Promise(r=>setTimeout(r,50));return fsRead(input);});
 agent.post('/v1/fs/write',async request=>fsWrite(request.body as Parameters<typeof fsWrite>[0]));
 const url=await agent.listen({host:'127.0.0.1',port:0});cleanups.push(()=>agent.close());
 const bridge=new AgentClient([{name:'fixture',url,userUrl:url},{name:'alias',url,userUrl:url}]);
 const server=new McpServer({name:'sync-fixture',version:'1'});installDefaultToolOutputContracts(server);registerTransferTools(server,bridge);
 const client=new Client({name:'validation-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);await client.listTools();cleanups.push(async()=>{await client.close();await server.close();});
 const args={sourceDevice:'fixture',sourcePath:source,destinationDevice:'fixture',destinationPath:destination,sourceContext:'user',destinationContext:'user',concurrency:1};
 return {root,source,destination,client,bridge,args,reads};
}
it.each(['nested','identical','ancestor','symlink','device-alias'])('rejects %s directory overlap through the SDK before mutation',async mode=>{
 const f=await fixture();let destination=f.destination;
 if(mode==='nested'||mode==='device-alias')destination=path.join(f.source,'backup','nested');
 if(mode==='identical')destination=f.source;
 if(mode==='ancestor')destination=f.root;
 if(mode==='symlink'){const alias=path.join(f.root,'link');await symlink(f.source,alias,process.platform==='win32'?'junction':'dir');destination=path.join(alias,'backup');}
 const result=await f.client.callTool({name:'directory_sync',arguments:{...f.args,destinationPath:destination,...(mode==='device-alias'?{destinationDevice:'alias'}:{})}});
 expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({ok:false,code:'directory_sync_overlap',destinationMutationAttempted:false});expect(f.reads).toEqual([]);
 if(mode==='nested'||mode==='device-alias'||mode==='symlink')await expect(stat(destination)).rejects.toMatchObject({code:'ENOENT'});
});
it('reports completed, failed and unattempted paths after a partial SDK operation',async()=>{
 const f=await fixture(true);const result=await f.client.callTool({name:'directory_sync',arguments:f.args});
 expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({code:'directory_sync_partial',filesTransferred:1,filesFailed:1,filesNotAttempted:1,filesUnchanged:0,bytes:5,partialEffectsPossible:true});
 expect((result.structuredContent as Record<string,unknown>).transferred).toEqual([expect.objectContaining({relative:'01-good'})]);expect((result.structuredContent as Record<string,unknown>).failed).toEqual([expect.objectContaining({relative:'02-fail',destinationState:'unverified'})]);expect((result.structuredContent as Record<string,unknown>).notAttempted).toEqual(['03-late']);
 expect(await readFile(path.join(f.destination,'01-good'),'utf8')).toBe('first');await expect(stat(path.join(f.destination,'03-late'))).rejects.toMatchObject({code:'ENOENT'});
});
it('drains a slower already-started worker before finalizing the partial receipt',async()=>{
 const f=await fixture(true,true);const result=await f.client.callTool({name:'directory_sync',arguments:{...f.args,concurrency:2}});
 expect(result.structuredContent).toMatchObject({code:'directory_sync_partial',filesTransferred:1,filesFailed:1,filesNotAttempted:1});expect(await readFile(path.join(f.destination,'01-good'),'utf8')).toBe('first');expect(f.reads.some(value=>value.endsWith('03-late'))).toBe(false);
});
it('allows disjoint sibling directories and repeat size/mtime synchronization',async()=>{
 const f=await fixture();const first=await f.client.callTool({name:'directory_sync',arguments:{...f.args,compare:'size-mtime'}});expect(first.isError).not.toBe(true);expect(first.structuredContent).toMatchObject({filesTransferred:3});
 const second=await f.client.callTool({name:'directory_sync',arguments:{...f.args,compare:'size-mtime'}});expect(second.isError).not.toBe(true);expect(second.structuredContent).toMatchObject({filesTransferred:0,filesUnchanged:3});
});
it('retains Windows case-insensitive boundaries without treating string prefixes as ancestors',()=>{
 expect(overlappingPaths('C:\\Source','c:\\source\\backup','win32')).toBe(true);expect(overlappingPaths('C:\\Source','C:\\Sources','win32')).toBe(false);expect(overlappingPaths('/source','/source-other','linux')).toBe(false);
});
