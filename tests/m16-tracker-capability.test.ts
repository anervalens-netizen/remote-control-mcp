import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.runIf(process.platform === "win32")("configures native tracking without resource limits or blocking explicit breakaway", async () => {
  const source = await readFile(new URL("../apps/agent/src/windows-process-tracker.ts", import.meta.url), "utf8");
  const native = source.match(/Add-Type @'\r?\n([\s\S]*?)\r?\n'@/);
  expect(native).not.toBeNull();
  expect(source).toContain("[RcmcpJobObject]::PreserveExplicitBreakaway($job)");
  const query = `
public static class RcmcpFlagProbe {
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool QueryInformationJobObject(System.IntPtr job, int infoClass, ref RcmcpJobObject.EXTENDED_LIMITS info, uint length, out uint returned);
  public static uint Flags(System.IntPtr job) {
    var info = new RcmcpJobObject.EXTENDED_LIMITS(); uint returned;
    if (!QueryInformationJobObject(job, 9, ref info, (uint)System.Runtime.InteropServices.Marshal.SizeOf(info), out returned)) throw new System.Exception("QueryInformationJobObject failed");
    return info.BasicLimitInformation.LimitFlags;
  }
}`;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type @'\n${native![1]}\n${query}\n'@\n$job=[RcmcpJobObject]::CreateJobObject([IntPtr]::Zero,$null)\nif($job -eq [IntPtr]::Zero){throw 'create failed'}\ntry{if(-not [RcmcpJobObject]::PreserveExplicitBreakaway($job)){throw 'configure failed'};[Console]::WriteLine([RcmcpFlagProbe]::Flags($job))}finally{[RcmcpJobObject]::CloseHandle($job)|Out-Null}`;
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 12000 });
  expect(result.stdout.trim()).toBe("2048");
}, 15000);
