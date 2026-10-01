import { mkdtemp,writeFile,readFile,rm } from "node:fs/promises";
import os from "node:os";import path from "node:path";
import { expect,it } from "vitest";
import { JobHistoryIndex } from "../apps/agent/src/job-history-index.ts";
it("isolates syntactically valid receipts that violate emitted status fields",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"rcmcp-history-corrupt-"));
 const bad=[{pid:"invalid"},{processIdentity:42},{terminationVerified:"yes"},{terminationForced:0},{terminationVerification:"unsupported"},{terminationVerificationScope:"unsupported"},{terminationReason:5},{cancellationError:false},{recoveryReason:{}},{progressInterrupted:"yes"},{trackedProcessCount:-1}];
 try {
  await writeFile(path.join(root,"valid.json"),JSON.stringify({id:"valid",startedAt:"2026-01-01",state:"completed",pid:123}));
  for(let i=0;i<bad.length;i++)await writeFile(path.join(root,"bad"+i+".json"),JSON.stringify({id:"bad"+i,startedAt:"2026-01-01",state:"completed",...bad[i]}));
  const page=await new JobHistoryIndex(root).page({limit:100});
  expect(page).toMatchObject({ids:["valid"],partial:true,corruptCount:bad.length});
  expect(await readFile(path.join(root,"bad0.json"),"utf8")).toContain('"invalid"');
 }finally{await rm(root,{recursive:true,force:true});}
});
