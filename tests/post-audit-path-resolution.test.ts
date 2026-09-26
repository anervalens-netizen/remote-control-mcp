import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {resolveProspectivePath} from '../apps/agent/src/path-resolution.ts';
import {validateDirectorySeparation} from '../apps/mcp-server/src/directory-paths.ts';
import {fsManage} from '../apps/agent/src/filesystem.ts';
import type {AgentClient} from '../apps/mcp-server/src/agent-client.ts';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const p=await mkdtemp(path.join(os.tmpdir(),'path-resolution-'));roots.push(p);return p;}
it('resolves symlinks before dot segments when descendants do not exist',async()=>{
 const p=await root(),source=path.join(p,'source');await mkdir(path.join(source,'inner'),{recursive:true});const alias=path.join(p,'alias');await symlink(path.join(source,'inner'),alias,process.platform==='win32'?'junction':'dir');
 const prospective=alias+path.sep+'..'+path.sep+'backup';
 const target=await resolveProspectivePath(prospective);expect(target.resolvedPath).toBe(path.join(source,'backup'));
 const client={fsManage:async(_name:string,input:Parameters<typeof fsManage>[0])=>fsManage(input)} as unknown as AgentClient;
 await expect(validateDirectorySeparation(client,{sourceDevice:'fixture',sourcePath:source,destinationDevice:'fixture',destinationPath:prospective},{platform:process.platform},{platform:process.platform},'system','user',{})).rejects.toMatchObject({receipt:{code:'directory_sync_overlap'}});
});
it('does not mistake a dangling link for a missing ordinary directory',async()=>{
 const p=await root(),alias=path.join(p,'dangling');await symlink(path.join(p,'missing'),alias,process.platform==='win32'?'junction':'dir');await expect(resolveProspectivePath(path.join(alias,'child'))).rejects.toThrow('dangling');
});
it('resolves relative inputs using the agent working directory',async()=>{
 const p=await root();const relative=path.relative(process.cwd(),path.join(p,'missing','child'));const resolved=await resolveProspectivePath(relative);expect(resolved.resolvedPath).toBe(path.join(p,'missing','child'));
});

it.each([['http://192.0.2.1:1234','http://192.0.2.2:1234'],['http://127.0.0.1:1234','http://127.0.0.1:5678']])('does not infer a shared filesystem from duplicate hostnames (%s, %s)',async(a,b)=>{
 let calls=0;
 const client={getDevice:(name:string)=>({name,url:name==='a'?a:b}),fsManage:async()=>{calls++;throw new Error('unrelated filesystem must not be resolved');}} as unknown as AgentClient;
 await validateDirectorySeparation(client,{sourceDevice:'a',sourcePath:'/data',destinationDevice:'b',destinationPath:'/data'},{platform:'linux',hostname:'cloned-host'},{platform:'linux',hostname:'cloned-host'},'system','system',{});
 expect(calls).toBe(0);
});
