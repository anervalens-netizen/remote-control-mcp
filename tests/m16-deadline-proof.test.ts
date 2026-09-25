import { expect, it } from "vitest";
import { runProcess } from "../apps/agent/src/exec.ts";
import { ptyList, ptyOutput, ptyRemove, ptyStart, ptyTerminate, ptyInput } from "../apps/agent/src/pty.ts";

it.each([0, 2_147_483_648, Number.MAX_SAFE_INTEGER])("does not turn exec timeout %s into a 1ms native timer", async timeoutMs => {
  const result=await runProcess(process.execPath,["-e","setTimeout(()=>console.log('LONG_DEADLINE_OK'),30)"],{timeoutMs});
  expect(result.code).toBe(0);expect(result.timedOut).toBe(false);expect(result.stdout).toContain("LONG_DEADLINE_OK");
},10000);

it("does not turn a natural terminal exit into a whole-tree termination claim",async()=>{
  const session=await ptyStart({shell:process.platform==="win32"?"cmd.exe":"/bin/bash"});
  try {
    ptyInput(session.id,"exit\r");
    const deadline=Date.now()+6000;
    while(Date.now()<deadline && !ptyOutput(session.id).exited)await new Promise(resolve=>setTimeout(resolve,30));
    expect(ptyOutput(session.id).exited).toBe(true);
    expect(ptyOutput(session.id).terminationVerified).toBe(false);
    expect(ptyList().find(item=>item.id===session.id)?.terminationVerified).toBe(false);
    expect((await ptyTerminate(session.id)).terminationVerified).toBe(false);
  }finally{await ptyRemove(session.id,true);}
},10000);

it("handles failed concurrent cancellation cleanup without an unhandled rejection", async () => {
  const { jobCancel } = await import("../apps/agent/src/jobs.ts");
  await expect(jobCancel("m16-nonexistent-cancel-fixture")).rejects.toThrow();
  await new Promise(resolve=>setTimeout(resolve,20));
});
