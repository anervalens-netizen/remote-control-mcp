import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsManage, fsRead, fsWrite } from "../apps/agent/src/filesystem.ts";
import { transferFile } from "../apps/mcp-server/src/transfer-tools.ts";
const roots: string[]=[];
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
describe.skipIf(process.platform!=="win32")("transfer into an extended-length parent directory",()=>{
 it.each([false,true])("creates private staging and preserves content with existing=%s",async existing=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"rcmcp-deep-parent-"));roots.push(root);
  const parent=path.join(root,"a".repeat(120),"b".repeat(120));await mkdir(parent,{recursive:true});
  expect(parent.length).toBeGreaterThan(260);
  const source=path.join(root,"source.bin"),destination=path.join(parent,"dest.bin"),bytes=Buffer.alloc(131072,75);
  await writeFile(source,bytes);if(existing)await writeFile(destination,"old synthetic destination");
  const client={info:async()=>({platform:process.platform,runtime:{transferStagingVersion:1,relaySourceVersion:1}}),
   fsManage:async(_device:string,input:Parameters<typeof fsManage>[0])=>fsManage(input),
   fsRead:async(_device:string,input:Parameters<typeof fsRead>[0])=>fsRead(input),
   fsWrite:async(_device:string,input:Parameters<typeof fsWrite>[0])=>fsWrite(input)};
  const result=await transferFile(client as any,{sourceDevice:"fixture-a",sourcePath:source,destinationDevice:"fixture-b",destinationPath:destination,chunkBytes:65536});
  expect(result).toMatchObject({ok:true,bytes:bytes.length,sourceStableVerified:true});
  expect(await readFile(source)).toEqual(bytes);expect(await readFile(destination)).toEqual(bytes);
 },20000);
});
