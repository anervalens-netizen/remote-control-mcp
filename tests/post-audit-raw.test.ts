import {createServer,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentClient} from '../apps/mcp-server/src/agent-client.ts';
import {importRemoteSecret} from '../apps/mcp-server/src/secret-tools.ts';
import {SecretStore} from '../apps/mcp-server/src/secret-store.ts';
const servers:Server[]=[],roots:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function listen(server:Server){servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
it.each([301,302,303,307,308])('does not follow raw-file HTTP %s or overwrite an existing alias',async status=>{
 let redirected=0,requests=0;
 const target=await listen(createServer((req,res)=>{req.resume();redirected++;res.writeHead(200,{'content-length':'4'}).end('evil');}));
 const origin=await listen(createServer((req,res)=>{req.resume();if(req.url==='/v1/fs/manage'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({size:4,isFile:true}));}else{requests++;res.writeHead(status,{location:target+'/v1/fs/raw'}).end();}}));
 const root=await mkdtemp(path.join(os.tmpdir(),'raw-alias-'));roots.push(root);const store=new SecretStore(root);await store.put('fixture',Buffer.from('old'));
 await expect(importRemoteSecret(new AgentClient([{name:'fixture',url:origin}]),store,{alias:'fixture',sourceDevice:'fixture',sourcePath:'fixture'})).rejects.toThrow();
 expect(requests).toBe(1);expect(redirected).toBe(0);expect(await store.read('fixture')).toEqual(Buffer.from('old'));
});
it('cancels an oversized raw error while reading, not after consuming the complete body',async()=>{
 let produced=0,cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull(controller){produced+=4096;controller.enqueue(new Uint8Array(4096));if(produced>=256*1024)controller.close();},cancel(){cancelled=true;}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:500})));
 await expect(new AgentClient([{name:'fixture',url:'http://127.0.0.1:1'}]).rawFile('fixture','fixture')).rejects.toMatchObject({kind:'http',status:500,responseBodyTruncated:true});
 expect(cancelled).toBe(true);expect(produced).toBeLessThanOrEqual(80*1024);expect(produced).toBeLessThan(256*1024);
});
it('retains ordinary bounded diagnostics but excludes unrelated credential fields',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:'fixture_error',message:'expected',credentials:'not-public'},{status:400})));
 const result=await new AgentClient([{name:'fixture',url:'http://127.0.0.1:1'}]).rawFile('fixture','fixture').catch(error=>error);
 expect(result).toMatchObject({kind:'http',status:400,responseBodyTruncated:false});expect(result.message).toContain('fixture_error');expect(result.message).not.toContain('not-public');
});
it('times out and closes an unfinished raw error body',async()=>{
 const origin=await listen(createServer((_req,res)=>{res.writeHead(500,{'content-type':'text/plain'});res.write('unfinished');}));
 await expect(new AgentClient([{name:'fixture',url:origin}]).rawFile('fixture','fixture','system',100)).rejects.toMatchObject({kind:'timeout'});
});
it('closes the raw response when import preflight rejects its advertised size',async()=>{
 const cancel=vi.fn(async()=>{}),root=await mkdtemp(path.join(os.tmpdir(),'raw-size-'));roots.push(root);const store=new SecretStore(root);
 const client={fsManage:async()=>({isFile:true,size:4}),rawFile:async()=>({size:5,cancel,chunks:(async function*(){yield Buffer.from('12345');})()})} as unknown as AgentClient;
 await expect(importRemoteSecret(client,store,{alias:'fixture',sourceDevice:'fixture',sourcePath:'fixture'})).rejects.toThrow('changed before streaming');expect(cancel).toHaveBeenCalledOnce();
});
it('still accepts and streams a valid raw-file response',async()=>{
 const origin=await listen(createServer((_req,res)=>res.writeHead(200,{'content-length':'7'}).end('fixture')));
 const raw=await new AgentClient([{name:'fixture',url:origin}]).rawFile('fixture','fixture');const chunks=[];for await(const chunk of raw.chunks)chunks.push(chunk);expect(Buffer.concat(chunks).toString()).toBe('fixture');await raw.cancel();
});
