import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStartDeduplicator } from "../apps/agent/src/job-start-dedup.ts";
import { jobStart, jobStatusAsync } from "../apps/agent/src/jobs.ts";
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const value=await mkdtemp(path.join(os.tmpdir(),'job-dedup-'));roots.push(value);return value;}
describe('optional durable job keys',()=>{
 it('coalesces concurrent requests and recovers the same ID across store instances',async()=>{
  const dir=await root(),store=new JobStartDeduplicator(dir),input={command:'synthetic',idempotencyKey:'key',env:{B:'2',A:'1'}};
  const receipts=new Map<string,{id:string}>();
  const start=vi.fn(async(id:string)=>{await new Promise(r=>setTimeout(r,25));const receipt={id};receipts.set(id,receipt);return receipt;});
  const lookup=vi.fn(async(id:string)=>{const receipt=receipts.get(id);if(!receipt)throw new Error('missing');return receipt;});
  const [a,b]=await Promise.all([store.run(input,start,lookup),store.run(input,start,lookup)]);expect(a).toEqual(b);expect(start).toHaveBeenCalledTimes(1);
  const restarted=new JobStartDeduplicator(dir);
  expect(await restarted.run({...input,env:{A:'1',B:'2'}},start,lookup)).toEqual(a);expect(start).toHaveBeenCalledTimes(1);
  await expect(restarted.run({...input,command:'different'},start,lookup)).rejects.toMatchObject({code:'job_start_conflict'});
 });
 it('retains uncertainty after a failed launch and never retries the effect',async()=>{
  const dir=await root(),input={command:'synthetic',idempotencyKey:'uncertain'};
  const start=vi.fn(async(_id:string)=>{throw new Error('lost result');}),lookup=async(_id:string)=>{throw new Error('missing metadata');};
  await expect(new JobStartDeduplicator(dir).run(input,start,lookup)).rejects.toThrow('lost result');
  await expect(new JobStartDeduplicator(dir).run(input,start,lookup)).rejects.toMatchObject({code:'job_start_uncertain'});expect(start).toHaveBeenCalledTimes(1);
 });
 it('fails closed for an incomplete reservation rather than overwriting it',async()=>{
  const dir=await root(),input={command:'synthetic',idempotencyKey:'corrupt'},store=new JobStartDeduplicator(dir);
  await store.run(input,async id=>({id}),async()=>({id:'unused'}));
  const [file]=await readdir(dir);await writeFile(path.join(dir,file!),'partial');
  const start=vi.fn(async(id:string)=>({id}));
  await expect(new JobStartDeduplicator(dir).run(input,start,async id=>({id}))).rejects.toMatchObject({code:'job_start_uncertain'});expect(start).not.toHaveBeenCalled();
 });
 it('preserves repeatable starts when no key is supplied',async()=>{
  const store=new JobStartDeduplicator(await root()),start=vi.fn(async(id:string)=>({id}));
  const a=await store.run({command:'same'},start,async id=>({id}));const b=await store.run({command:'same'},start,async id=>({id}));expect(a.id).not.toBe(b.id);expect(start).toHaveBeenCalledTimes(2);
 });
 it('replays a real job receipt instead of launching a second process',async()=>{
  const command=process.platform==='win32'?'Write-Output dedup-fixture':'printf dedup-fixture';
  const input={command,idempotencyKey:'real-job-fixture'};
  const [a,b]=await Promise.all([jobStart(input),jobStart(input)]);expect(a.id).toBe(b.id);
  let status=await jobStatusAsync(a.id);const deadline=Date.now()+10000;
  while(status.state==='running'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,50));status=await jobStatusAsync(a.id);}
  expect(status.state).toBe('completed');expect(status.exitCode).toBe(0);
  expect((await jobStart(input)).id).toBe(a.id);
 });
});
