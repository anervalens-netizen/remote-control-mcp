import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
export type JobStartInput = { command: string; cwd?: string; env?: Record<string,string>; idempotencyKey?: string };
type Reservation = { version: 1; jobId: string; fingerprint: string };
export class JobStartKeyError extends Error {
  code: "job_start_conflict" | "job_start_uncertain";
  jobId?: string;
  constructor(code: JobStartKeyError["code"], jobId?: string) {
    super((code === "job_start_conflict" ? "Job key was already used with different input" : "Job start outcome is uncertain; inspect the reserved job before submitting a new key") + (jobId ? ` (jobId=${jobId})` : ""));
    this.name="JobStartKeyError";this.code=code;this.jobId=jobId;
  }
}
function fingerprint(input: JobStartInput): string {
  const env=Object.entries(input.env??{}).sort(([a],[b])=>a<b?-1:a>b?1:0);
  return createHash("sha256").update(JSON.stringify([input.command,input.cwd??null,env])).digest("hex");
}
// A reservation is written before launching. A missing/failed receipt after a
// restart is an uncertain effect, never permission to launch the command again.
// Keep reservations when output/job metadata is removed; reuse needs a new key.
export class JobStartDeduplicator {
  root: string;
  inFlight = new Map<string,{ fingerprint: string; promise: Promise<unknown> }>();
  constructor(root: string) { this.root=root; }
  async run<T>(input: JobStartInput, start: (id:string)=>Promise<T>, lookup: (id:string)=>Promise<T>): Promise<T> {
    if(input.idempotencyKey===undefined)return start(randomUUID());
    if(!input.idempotencyKey.length||input.idempotencyKey.length>200)throw new Error("Job idempotencyKey must contain 1 to 200 characters");
    const key=createHash("sha256").update(input.idempotencyKey).digest("hex"), digest=fingerprint(input);
    const pending=this.inFlight.get(key);
    if(pending){if(pending.fingerprint!==digest)throw new JobStartKeyError("job_start_conflict");return pending.promise as Promise<T>;}
    const promise=Promise.resolve().then(async()=>{
      const file=path.join(this.root,key+".json");
      let fd:number;
      try{fd=openSync(file,"wx",0o600);}catch(error){
        if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
        let record:Reservation;
        try{
          record=JSON.parse(readFileSync(file,"utf8"));
          if(record.version!==1||!/^[-a-f0-9]{36}$/.test(record.jobId)||!/^[a-f0-9]{64}$/.test(record.fingerprint))throw new Error("Invalid reservation");
        }catch{throw new JobStartKeyError("job_start_uncertain");}
        if(record.fingerprint!==digest)throw new JobStartKeyError("job_start_conflict",record.jobId);
        try{return await lookup(record.jobId);}catch{throw new JobStartKeyError("job_start_uncertain",record.jobId);}
      }
      const record:Reservation={version:1,jobId:randomUUID(),fingerprint:digest};
      try{writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}
      if(process.platform!=="win32"){
        const directory=openSync(this.root,"r");try{fsyncSync(directory);}finally{closeSync(directory);}
      }
      return start(record.jobId);
    });
    this.inFlight.set(key,{fingerprint:digest,promise});
    try{return await promise;}finally{this.inFlight.delete(key);}
  }
}
