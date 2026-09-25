import { jobStart } from "./jobs.ts";
import { nativeCommand } from "./shell-quote.ts";
import { powerSchema,type PowerInput } from "../../../packages/protocol/src/power.ts";

export function powerPlan(input:PowerInput,platform:NodeJS.Platform=process.platform){
  const parsed=powerSchema.parse(input),delaySeconds=parsed.delaySeconds??(parsed.action==="lock"?0:5);
  let command:string,forceApplied=false;
  if(platform==="win32"){
    if(parsed.action==="reboot"||parsed.action==="shutdown"||parsed.action==="hibernate"){
      const args=parsed.action==="hibernate"?["/h"]:[parsed.action==="reboot"?"/r":"/s","/t","0"];
      if(parsed.force){args.push("/f");forceApplied=true}
      command=nativeCommand(["shutdown.exe",...args],platform);
    }else{
      const script=parsed.action==="sleep"
        ? "Add-Type -AssemblyName System.Windows.Forms; if(-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend,$false,$false)){throw 'Windows rejected the suspend request'}"
        : "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class RcmcpPower { [DllImport(\"user32.dll\",SetLastError=true)] public static extern bool LockWorkStation(); }'; if(-not [RcmcpPower]::LockWorkStation()){throw [System.ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())}";
      command=nativeCommand(["powershell.exe","-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from("$ErrorActionPreference='Stop'; "+script,"utf16le").toString("base64")],platform);
    }
    command=(delaySeconds? "Start-Sleep -Seconds "+delaySeconds+"; ":"")+command;
  }else if(platform==="linux"){
    const verb=parsed.action==="shutdown"?"poweroff":parsed.action==="sleep"?"suspend":parsed.action;
    forceApplied=!!parsed.force&&["reboot","shutdown"].includes(parsed.action);
    command=nativeCommand(parsed.action==="lock"?["loginctl","lock-sessions"]:["systemctl",verb,...(forceApplied?["--force"]:[])],platform);
    command=(delaySeconds?"sleep "+delaySeconds+" && ":"")+command;
  }else throw new Error("Power control is implemented for Linux and Windows; use exec for this platform");
  return {platform,action:parsed.action,delaySeconds,forceRequested:parsed.force??false,forceApplied,command};
}
export async function hostPower(input:PowerInput,start:typeof jobStart=jobStart){
  const plan=powerPlan(input);
  if(input.dryRun)return {ok:true,dryRun:true,scheduled:false,powerStateVerified:false,plan};
  const job=await start({command:plan.command});
  return {ok:true,scheduled:true,submissionVerified:true,powerStateVerified:false,action:plan.action,delaySeconds:plan.delaySeconds,forceApplied:plan.forceApplied,job,
    verification:"A durable job was started. Use job_wait/job_status/output for OS command results and device_info after reconnect; submission does not prove a physical power transition."};
}
