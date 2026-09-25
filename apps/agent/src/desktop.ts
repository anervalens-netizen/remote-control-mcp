import { desktopFocusSchema, desktopMouseSchema, desktopKeyboardSchema } from "../../../packages/protocol/src/desktop.ts";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { runtimeEnv } from "./runtime-env.ts";
import { DesktopHelper, desktopHelperPowerShell } from "./desktop-helper.ts";
import { uiaScript } from "./desktop-uia.ts";
import { windowsPrelude, windowsScript } from "./desktop-windows.ts";
import type { DesktopUiaInput, DesktopWindowsInput, DesktopBatchAction } from "../../../packages/protocol/src/desktop.ts";
import { setTimeout as wait } from "node:timers/promises";
import { captureDesktopFile } from "./desktop-screenshot.ts";
import { desktopCancellation, desktopSequence } from "./desktop-sequence.ts";

const execFileAsync = promisify(execFile);
function assertWindows() { if (process.platform !== "win32") throw new Error("Desktop control is currently implemented for Windows interactive sessions"); }

const desktopSessionProbePowerShell = String.raw`if(-not ("RcmcpDesktopProbe" -as [type])){ Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RcmcpDesktopProbe {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, uint length, out uint needed);
}
'@ }
function Get-RcmcpDesktopSessionStatus {
  $agentPid = $null
  if ($env:RCMCP_DESKTOP_AGENT_PID) { $agentPid = [int]$env:RCMCP_DESKTOP_AGENT_PID }
  $agent = if ($agentPid) { Get-Process -Id $agentPid -ErrorAction SilentlyContinue } else { $null }
  $agentSessionId = if ($agent) { [int]$agent.SessionId } else { $null }
  $activeRaw = [RcmcpDesktopProbe]::WTSGetActiveConsoleSessionId()
  $activeConsoleSessionId = if ($activeRaw -eq [uint32]::MaxValue) { $null } else { [int]$activeRaw }

  $inputDesktopName = $null
  $inputDesktopAccessible = $false
  $inputDesktopError = $null
  $desktop = [RcmcpDesktopProbe]::OpenInputDesktop(0, $false, 1)
  if ($desktop -ne [IntPtr]::Zero) {
    try {
      $builder = New-Object System.Text.StringBuilder 256
      $needed = [uint32]0
      $inputDesktopAccessible = [RcmcpDesktopProbe]::GetUserObjectInformation(
        $desktop, 2, $builder, [uint32]($builder.Capacity * 2), [ref]$needed
      )
      if ($inputDesktopAccessible) { $inputDesktopName = $builder.ToString() }
      else { $inputDesktopError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    } finally {
      [void][RcmcpDesktopProbe]::CloseDesktop($desktop)
    }
  } else {
    $inputDesktopError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  }

  $consent = @()
  Get-Process -Name consent -ErrorAction SilentlyContinue | ForEach-Object {
    $sessionId = $null
    try { $sessionId = [int]$_.SessionId } catch {}
    $consent += [pscustomobject]@{ pid = [int]$_.Id; sessionId = $sessionId }
  }
  $secureDesktopLikely = ($inputDesktopName -eq 'Winlogon') -or ($consent.Count -gt 0)
  [pscustomobject]@{
    agentPid = $agentPid
    agentSessionId = $agentSessionId
    activeConsoleSessionId = $activeConsoleSessionId
    interactiveSession = ($null -ne $agentSessionId -and $agentSessionId -ne 0)
    inputDesktop = @{
      accessible = [bool]$inputDesktopAccessible
      name = $inputDesktopName
      error = $inputDesktopError
    }
    consentProcesses = @($consent)
    secureDesktopLikely = [bool]$secureDesktopLikely
    uacPromptPossible = [bool]$secureDesktopLikely
    captureMayMissSecureDesktop = [bool]$secureDesktopLikely
    captureBoundaryNote = 'Windows UAC can switch to Secure Desktop, which is outside normal desktop capture/control. secureDesktopLikely reports current evidence only.'
  }
}`;

let helper: DesktopHelper | null = null;
export function closeDesktopHelper() { helper?.close(); helper = null; }
function getDesktopHelper() {
  return helper ??= new DesktopHelper("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
    Buffer.from(desktopHelperPowerShell, "utf16le").toString("base64"),
  ], { env: runtimeEnv({ RCMCP_DESKTOP_AGENT_PID: String(process.pid) }) });
}

async function runPowerShellOneShot(script: string, input?: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rcmcp-desktop-"));
  const inputPath = path.join(dir, "input.json");
  const scriptPath = path.join(dir, "run.ps1");
  await writeFile(scriptPath, "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)\n" + script, "utf8");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
  if (input !== undefined) { await writeFile(inputPath, JSON.stringify(input), "utf8"); args.push(inputPath); }
  try {
    const { stdout } = await execFileAsync("powershell.exe", args, {
      env: runtimeEnv({ RCMCP_DESKTOP_AGENT_PID: String(process.pid) }), windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function runPowerShell(script: string, input?: unknown) {
  assertWindows();
  return desktopSequence(() => {
    if (process.env.RCMCP_DESKTOP_HELPER === "0") return runPowerShellOneShot(script, input);
    // Pass input as an object in memory. No per-action process or input file.
    const persistentScript = script.replace(/Get-Content -Raw -Encoding UTF8 -LiteralPath \$args\[0\]\s*\|\s*ConvertFrom-Json/g, "$RcmcpInput");
    return getDesktopHelper().request(persistentScript, input);
  });
}

export function desktopHelperStatus() {
  return {
    enabled: process.env.RCMCP_DESKTOP_HELPER !== "0", transport: process.env.RCMCP_DESKTOP_HELPER === "0" ? "oneshot" : "persistent",
    ...(helper?.status() ?? { running: false, pid: null, busy: false, starts: 0, completed: 0, lastError: null }),
  };
}

export async function desktopMonitors() {
  const value = await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; $out=@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ deviceName=$_.DeviceName; primary=$_.Primary; bitsPerPixel=$_.BitsPerPixel; bounds=@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height}; workingArea=@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height} } }); ConvertTo-Json -InputObject $out -Compress -Depth 5`);
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

export async function desktopUia(input: DesktopUiaInput) { return runPowerShell(uiaScript, input); }

export async function desktopWindows(input: DesktopWindowsInput = {}) {
  const value = await runPowerShell(windowsScript, input);
  return Array.isArray(value) ? value : value === null ? [] : [value];
}

export async function desktopScreenshot(input: { monitor?: number | "all"; scale?: number }): Promise<unknown> {
  return desktopSequence(() => captureDesktopFile(outputPath => runPowerShell(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0] | ConvertFrom-Json
if($i.monitor -eq 'all'){ $b=[System.Windows.Forms.SystemInformation]::VirtualScreen }
elseif($null -ne $i.monitor){
  $screens=[System.Windows.Forms.Screen]::AllScreens;$idx=[int]$i.monitor
  if($idx -lt 0 -or $idx -ge $screens.Count){throw 'monitor index out of range'}
  $b=$screens[$idx].Bounds
}else{$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds}
$bmp=$null;$g=$null;$scaled=$null;$sg=$null
try {
  $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left,$b.Top,0,0,$b.Size);$g.Dispose();$g=$null
  $scale=if($i.scale){[double]$i.scale}else{1.0}
  if($scale -ne 1.0){
    $w=[Math]::Max(1,[int]($b.Width*$scale));$h=[Math]::Max(1,[int]($b.Height*$scale))
    $scaled=New-Object System.Drawing.Bitmap $w,$h
    $sg=[System.Drawing.Graphics]::FromImage($scaled);$sg.DrawImage($bmp,0,0,$w,$h)
    $sg.Dispose();$sg=$null;$bmp.Dispose();$bmp=$scaled;$scaled=$null
  }
  $bmp.Save([string]$i.outputPath,[System.Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{originX=$b.Left;originY=$b.Top;sourceWidth=$b.Width;sourceHeight=$b.Height;width=$bmp.Width;height=$bmp.Height;scale=$scale}|ConvertTo-Json -Compress
} finally {
  foreach($resource in @($g,$sg,$bmp,$scaled)){if($null -ne $resource){$resource.Dispose()}}
}`, { ...input, outputPath })));
}

export async function desktopFocus(input: { handle?: number; pid?: number; title?: string }) {
  input = desktopFocusSchema.parse(input);
  return runPowerShell(windowsPrelude + `$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json; if(-not ("RcmcpFocus" -as [type])){ Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class RcmcpFocus { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from,uint to,bool attach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
public static bool Focus(IntPtr h) {
  if(GetForegroundWindow()==h)return true;
  uint unused; uint current=GetCurrentThreadId();
  uint foreground=GetWindowThreadProcessId(GetForegroundWindow(),out unused);
  uint target=GetWindowThreadProcessId(h,out unused);
  bool attachedForeground=false,attachedTarget=false;
  try {
    if(foreground!=0 && foreground!=current)attachedForeground=AttachThreadInput(current,foreground,true);
    if(target!=0 && target!=current && target!=foreground)attachedTarget=AttachThreadInput(current,target,true);
    BringWindowToTop(h); return SetForegroundWindow(h);
  } finally {
    if(attachedTarget)AttachThreadInput(current,target,false);
    if(attachedForeground)AttachThreadInput(current,foreground,false);
  }
}
}\n'@ }; $h=[IntPtr]::Zero; if($i.handle){$h=[IntPtr][int64]$i.handle}elseif($i.pid){$w=[RcmcpWindows]::List()|Where-Object {$_.pid -eq [int]$i.pid -and $_.visible}|Select-Object -First 1;if($w){$h=[IntPtr][int64]$w.handle}}elseif($i.title){$w=[RcmcpWindows]::List()|Where-Object{$_.visible -and $_.title.IndexOf([string]$i.title,[StringComparison]::OrdinalIgnoreCase) -ge 0}|Select-Object -First 1;if($w){$h=[IntPtr][int64]$w.handle}}; if($h -eq [IntPtr]::Zero){throw 'window not found'}; [void][RcmcpFocus]::ShowWindowAsync($h,9); Start-Sleep -Milliseconds 80; $accepted=[RcmcpFocus]::SetForegroundWindow($h); if([RcmcpFocus]::GetForegroundWindow() -ne $h){$accepted=[RcmcpFocus]::Focus($h)}; Start-Sleep -Milliseconds 40; $foreground=[RcmcpFocus]::GetForegroundWindow(); [pscustomobject]@{ok=($foreground -eq $h);handle=[int64]$h;foregroundHandle=[int64]$foreground;nativeAccepted=$accepted}|ConvertTo-Json -Compress`, input);
}

export async function desktopMouse(input: { action: "position" | "move" | "click" | "doubleClick" | "scroll"; x?: number; y?: number; button?: "left" | "right" | "middle"; delta?: number }) {
  input = desktopMouseSchema.parse(input);
  return runPowerShell(`$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json; if(-not ("RcmcpMouse" -as [type])){ Add-Type @'\nusing System; using System.Runtime.InteropServices; public static class RcmcpMouse { [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; } [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,int data,UIntPtr extra); }\n'@ }; if($i.action -ne 'position' -and $null -ne $i.x -and $null -ne $i.y){[void][RcmcpMouse]::SetCursorPos([int]$i.x,[int]$i.y);Start-Sleep -Milliseconds 40}; $button=if($i.button){[string]$i.button}else{'left'}; $flags=@{left=@(2,4);right=@(8,16);middle=@(32,64)}; if($i.action -eq 'click' -or $i.action -eq 'doubleClick'){ $count=if($i.action -eq 'doubleClick'){2}else{1}; 1..$count|ForEach-Object{ $f=$flags[$button];[RcmcpMouse]::mouse_event([uint32]$f[0],0,0,0,[UIntPtr]::Zero);[RcmcpMouse]::mouse_event([uint32]$f[1],0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80 } } elseif($i.action -eq 'scroll'){$delta=if($null -ne $i.delta){[int]$i.delta}else{120};[RcmcpMouse]::mouse_event(2048,0,0,$delta,[UIntPtr]::Zero)}; $p=New-Object RcmcpMouse+POINT;[void][RcmcpMouse]::GetCursorPos([ref]$p);[pscustomobject]@{ok=$true;x=$p.X;y=$p.Y}|ConvertTo-Json -Compress`, input);
}

export async function desktopKeyboard(input: { action: "type" | "press" | "hotkey"; text?: string; keys?: string[] }) {
  input = desktopKeyboardSchema.parse(input);
  return runPowerShell(`$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Dispose-RcmcpClipboardData($data) {
  if($null -eq $data){return}
  foreach($format in @($data.GetFormats($false))){
    $value=$data.GetData($format,$false)
    if($value -is [System.IDisposable]){$value.Dispose()}
  }
}
function Copy-RcmcpClipboardData {
  $source=[System.Windows.Forms.Clipboard]::GetDataObject()
  if($null -eq $source){ return $null }
  $formats=@($source.GetFormats($false))
  $copy=New-Object System.Windows.Forms.DataObject
  try {
  foreach($format in $formats){
    $value=$source.GetData($format,$false)
    if($null -eq $value){ throw ('clipboard snapshot missing format data: '+[string]$format) }
    if($value -is [System.IO.Stream]){
      $position=$null
      if($value.CanSeek){ $position=$value.Position; $value.Position=0 }
      $stream=New-Object System.IO.MemoryStream
      $value.CopyTo($stream)
      $stream.Position=0
      if($null -ne $position -and $value.CanSeek){ $value.Position=$position }
      $value=$stream
    } elseif($value -is [System.Drawing.Image]){
      $value=$value.Clone()
    } elseif($value -is [System.Array]){
      $value=$value.Clone()
    } elseif($value -is [System.ICloneable]){
      $value=$value.Clone()
    }
    $copy.SetData([string]$format,$false,$value)
    if(-not $copy.GetDataPresent([string]$format,$false)){
      throw ('clipboard snapshot missing copied format: '+[string]$format)
    }
  }
  foreach($format in $formats){
    if(-not $copy.GetDataPresent([string]$format,$false)){
      throw ('clipboard snapshot incomplete: '+[string]$format)
    }
  }
  return $copy
  } catch { Dispose-RcmcpClipboardData $copy; throw }
}
if($i.action -eq 'type'){
  if($null -eq $i.text){ throw 'text is required' }
  $backup=$null
  $hadBackup=$false
  $formatCount=0
  $snapshotCaptured=$false
  $snapshotError=$null
  for($attempt=1;$attempt -le 6;$attempt++){
    try {
      $backup=Copy-RcmcpClipboardData
      if($null -ne $backup){
        $formatCount=@($backup.GetFormats($false)).Count
        $hadBackup=($formatCount -gt 0)
      }
      $snapshotCaptured=$true
      break
    } catch {
      $snapshotError=$_.Exception.Message
      if($attempt -lt 6){ Start-Sleep -Milliseconds 40 }
    }
  }
  if(-not $snapshotCaptured){
    [pscustomobject]@{
      ok=$false
      chars=0
      typed=$false
      clipboardSnapshotCaptured=$false
      clipboardSnapshotError=$snapshotError
      clipboardRestored=$false
      clipboardFormatsRestored=0
      clipboardRestoreAttempts=0
      clipboardRestoreError='clipboard snapshot failed; typing was not attempted'
    }|ConvertTo-Json -Compress
    return
  }

  $typingError=$null
  $typingAttempted=$false
  $restoreOk=$false
  $restoreError=$null
  $restoreAttempts=0
  try {
    $typingAttempted=$true
    [System.Windows.Forms.Clipboard]::SetText([string]$i.text)
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 120
  } catch {
    $typingError=$_.Exception.Message
  } finally {
    for($attempt=1;$attempt -le 6;$attempt++){
      $restoreAttempts=$attempt
      try {
        if($hadBackup){ [System.Windows.Forms.Clipboard]::SetDataObject($backup,$true,1,0) }
        else { [System.Windows.Forms.Clipboard]::Clear() }
        $restoreOk=$true
        $restoreError=$null
        break
      } catch {
        $restoreError=$_.Exception.Message
        if($attempt -lt 6){ Start-Sleep -Milliseconds 40 }
      }
    }
  }
  Dispose-RcmcpClipboardData $backup
  [pscustomobject]@{
    ok=($null -eq $typingError -and $restoreOk)
    chars=([string]$i.text).Length
    typed=($typingAttempted -and $null -eq $typingError)
    error=$typingError
    clipboardSnapshotCaptured=$true
    clipboardSnapshotError=$null
    clipboardRestored=$restoreOk
    clipboardFormatsRestored=if($restoreOk){$formatCount}else{0}
    clipboardRestoreAttempts=$restoreAttempts
    clipboardRestoreError=$restoreError
  }|ConvertTo-Json -Compress
  return
}

if(-not ("RcmcpKeys" -as [type])){ Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RcmcpKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
}
'@ }
$map=@{CTRL=17;CONTROL=17;ALT=18;SHIFT=16;WIN=91;ENTER=13;TAB=9;ESC=27;ESCAPE=27;BACKSPACE=8;DELETE=46;LEFT=37;UP=38;RIGHT=39;DOWN=40;HOME=36;END=35;PAGEUP=33;PAGEDOWN=34;SPACE=32;F1=112;F2=113;F3=114;F4=115;F5=116;F6=117;F7=118;F8=119;F9=120;F10=121;F11=122;F12=123}
function VK([string]$k){
  $u=$k.ToUpper()
  if($map.ContainsKey($u)){ return [byte]$map[$u] }
  if($u.Length -eq 1){ return [byte][char]$u }
  throw ('unsupported key: '+$k)
}
$keys=@($i.keys)
if(-not $keys.Count){ throw 'keys are required' }
$vks=@()
foreach($k in $keys){ $vks += (VK $k) }
if($i.action -eq 'hotkey'){
  $pressed=New-Object 'System.Collections.Generic.List[byte]'
  try {
    foreach($v in $vks){ [RcmcpKeys]::keybd_event([byte]$v,0,0,[UIntPtr]::Zero); $pressed.Add([byte]$v) }
  } finally {
    for($j=$pressed.Count-1;$j -ge 0;$j--){ [RcmcpKeys]::keybd_event([byte]$pressed[$j],0,2,[UIntPtr]::Zero) }
  }
} else {
  foreach($v in $vks){
    [RcmcpKeys]::keybd_event([byte]$v,0,0,[UIntPtr]::Zero)
    try {} finally { [RcmcpKeys]::keybd_event([byte]$v,0,2,[UIntPtr]::Zero) }
  }
}
[pscustomobject]@{ok=$true;keys=@($i.keys)}|ConvertTo-Json -Compress -Depth 3`, input);
}

export async function desktopClipboardGet() {
  return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [pscustomobject]@{text=[System.Windows.Forms.Clipboard]::GetText()}|ConvertTo-Json -Compress`);
}
export async function desktopClipboardSet(input: { text: string }) {
  return runPowerShell(`$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText([string]$i.text); [pscustomobject]@{ok=$true;chars=([string]$i.text).Length}|ConvertTo-Json -Compress`, input);
}
export async function desktopSessionStatus() {
  return runPowerShell(`${desktopSessionProbePowerShell}
Get-RcmcpDesktopSessionStatus | ConvertTo-Json -Compress -Depth 6`);
}

export async function desktopLaunch(input: { target: string; arguments?: string[]; waitForWindowMs?: number; requireWindow?: boolean }) {
  return runPowerShell(`${desktopSessionProbePowerShell}
if(-not ("RcmcpLaunchWindow" -as [type])){ Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RcmcpLaunchWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@ }
$i = Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0] | ConvertFrom-Json
$a = @($i.arguments)
$target = [string]$i.target
$waitMs = if ($null -ne $i.waitForWindowMs) { [int]$i.waitForWindowMs } else { 1500 }
$requireWindow = if ($null -ne $i.requireWindow) { [bool]$i.requireWindow } else { $false }
$startedAt = Get-Date
$p = if ($a.Count) {
  Start-Process -FilePath $target -ArgumentList $a -PassThru
} else {
  Start-Process -FilePath $target -PassThru
}
$launchPid = if ($p) { [int]$p.Id } else { $null }
$deadline = (Get-Date).AddMilliseconds($waitMs)
$candidate = $null
$windowProcess = $null
$base = [IO.Path]::GetFileNameWithoutExtension($target)
do {
  if ($launchPid) {
    $candidate = Get-Process -Id $launchPid -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.MainWindowHandle -ne 0) {
      $windowProcess = $candidate
      break
    }
  }
  if ($base) {
    $windowProcess = Get-Process -Name $base -ErrorAction SilentlyContinue |
      Where-Object {
        try { $_.MainWindowHandle -ne 0 -and $_.StartTime -ge $startedAt.AddSeconds(-1) }
        catch { $false }
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($windowProcess) {
      if (-not $candidate) { $candidate = $windowProcess }
      break
    }
  }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 50
} while ($true)

if (-not $candidate -and $launchPid) {
  $candidate = Get-Process -Id $launchPid -ErrorAction SilentlyContinue
}
$processPid = if ($candidate) { [int]$candidate.Id } elseif ($launchPid) { $launchPid } else { $null }
$processSessionId = if ($candidate) { try { [int]$candidate.SessionId } catch { $null } } else { $null }
$session = Get-RcmcpDesktopSessionStatus
$interactiveSessionMatched = (
  $session.interactiveSession -and
  $null -ne $session.agentSessionId -and
  $null -ne $processSessionId -and
  [int]$session.agentSessionId -eq [int]$processSessionId
)

$window = $null
if ($windowProcess -and $windowProcess.MainWindowHandle -ne 0) {
  $rect = New-Object RcmcpLaunchWindow+RECT
  [void][RcmcpLaunchWindow]::GetWindowRect($windowProcess.MainWindowHandle, [ref]$rect)
  $window = @{
    pid = [int]$windowProcess.Id
    process = $windowProcess.ProcessName
    title = $windowProcess.MainWindowTitle
    handle = [int64]$windowProcess.MainWindowHandle
    visible = [RcmcpLaunchWindow]::IsWindowVisible($windowProcess.MainWindowHandle)
    rect = @{
      x = $rect.Left
      y = $rect.Top
      width = ($rect.Right - $rect.Left)
      height = ($rect.Bottom - $rect.Top)
    }
  }
}
$processVerified = ($null -ne $candidate)
$windowVerified = ($null -ne $window)
$verified = $processVerified -and $interactiveSessionMatched -and ((-not $requireWindow) -or $windowVerified)
$status = if ($verified -and $windowVerified) { 'window' }
  elseif ($verified) { 'process' }
  elseif (-not $session.interactiveSession) { 'noninteractive_agent_session' }
  elseif ($processVerified -and -not $interactiveSessionMatched) { 'session_mismatch' }
  elseif ($requireWindow -and -not $windowVerified) { 'window_not_found' }
  else { 'process_not_verified' }

[pscustomobject]@{
  ok = [bool]$verified
  launchAccepted = $true
  verified = [bool]$verified
  verificationStatus = $status
  target = $target
  pid = $processPid
  processVerified = [bool]$processVerified
  agentSessionId = $session.agentSessionId
  activeConsoleSessionId = $session.activeConsoleSessionId
  processSessionId = $processSessionId
  interactiveSessionMatched = [bool]$interactiveSessionMatched
  windowVerified = [bool]$windowVerified
  window = $window
  waitForWindowMs = $waitMs
  requireWindow = [bool]$requireWindow
  uac = @{
    secureDesktopPromptPossible = $true
    secureDesktopLikely = $session.secureDesktopLikely
    uacPromptPossible = $session.uacPromptPossible
    captureMayMissSecureDesktop = $session.captureMayMissSecureDesktop
    inputDesktop = $session.inputDesktop
    consentProcesses = $session.consentProcesses
    note = $session.captureBoundaryNote
  }
} | ConvertTo-Json -Compress -Depth 8`, input);
}

export async function desktopBrowserOpen(input: { url: string; browser?: "auto" | "edge" | "chrome" | "brave" | "firefox"; newWindow?: boolean }) {
  return runPowerShell(`$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json; $candidates=@(); $pf=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles); $pfx=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86); if($i.browser -eq 'edge' -or $i.browser -eq 'auto' -or -not $i.browser){$candidates += @((Join-Path $pfx 'Microsoft\\Edge\\Application\\msedge.exe'),(Join-Path $pf 'Microsoft\\Edge\\Application\\msedge.exe'))}; if($i.browser -eq 'chrome' -or $i.browser -eq 'auto' -or -not $i.browser){$candidates += @((Join-Path $pf 'Google\\Chrome\\Application\\chrome.exe'),(Join-Path $pfx 'Google\\Chrome\\Application\\chrome.exe'))}; if($i.browser -eq 'brave' -or $i.browser -eq 'auto' -or -not $i.browser){$candidates += @((Join-Path $pf 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),(Join-Path $pfx 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'))}; if($i.browser -eq 'firefox' -or $i.browser -eq 'auto' -or -not $i.browser){$candidates += @((Join-Path $pf 'Mozilla Firefox\\firefox.exe'),(Join-Path $pfx 'Mozilla Firefox\\firefox.exe'))}; $exe=$candidates|Where-Object{$_ -and (Test-Path $_)}|Select-Object -First 1; if(-not $exe){throw 'No supported browser executable found'}; $name=[IO.Path]::GetFileName($exe).ToLower(); if($name -eq 'firefox.exe'){$a=if($i.newWindow -eq $false){@('-new-tab',[string]$i.url)}else{@('-new-window',[string]$i.url)}}else{$a=if($i.newWindow -eq $false){@('--new-tab',[string]$i.url)}else{@('--new-window',[string]$i.url)}}; $p=Start-Process -FilePath $exe -ArgumentList $a -PassThru; [pscustomobject]@{ok=$true;browser=$name;executable=$exe;pid=if($p){$p.Id}else{$null};url=[string]$i.url}|ConvertTo-Json -Compress`, input);
}


async function runDesktopBatchAction(action: DesktopBatchAction): Promise<unknown> {
  switch (action.kind) {
    case "monitors": return desktopMonitors();
    case "windows": return desktopWindows(action);
    case "uia": return desktopUia(action);
    case "session": return desktopSessionStatus();
    case "screenshot": return desktopScreenshot(action);
    case "browser": return desktopBrowserOpen(action);
    case "wait":
      await wait(action.ms, undefined, { signal: desktopCancellation() });
      return { ok: true, waitedMs: action.ms };
    case "focus": {
      const { kind: _kind, ...input } = action;
      return desktopFocus(input);
    }
    case "mouse": {
      const { kind: _kind, ...input } = action;
      return desktopMouse(input);
    }
    case "keyboard": {
      const { kind: _kind, ...input } = action;
      return desktopKeyboard(input);
    }
    case "clipboardGet": return desktopClipboardGet();
    case "clipboardSet": return desktopClipboardSet({ text: action.text });
    case "launch": {
      const { kind: _kind, ...input } = action;
      return desktopLaunch(input);
    }
  }
}

async function runDesktopBatch(input: { actions: DesktopBatchAction[]; stopOnError?: boolean }) {
  const results: Array<{ index: number; kind: DesktopBatchAction["kind"]; ok: boolean; result?: unknown; error?: string }> = [];
  const stopOnError = input.stopOnError ?? true;
  for (let index = 0; index < input.actions.length; index += 1) {
    desktopCancellation()?.throwIfAborted();
    const action = input.actions[index]!;
    try {
      const result = await runDesktopBatchAction(action);
      const semanticFailure = Boolean(result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false);
      results.push({ index, kind: action.kind, ok: !semanticFailure, result });
      if (semanticFailure && stopOnError) break;
    } catch (error) {
      results.push({ index, kind: action.kind, ok: false, error: error instanceof Error ? error.message : String(error) });
      if (stopOnError) break;
    }
  }
  return {
    ok: results.length === input.actions.length && results.every((item) => item.ok),
    requested: input.actions.length,
    executed: results.length,
    skipped: input.actions.length - results.length,
    stoppedOnError: results.length < input.actions.length,
    helper: desktopHelperStatus(),
    results,
  };
}

export function desktopBatch(input: { actions: DesktopBatchAction[]; stopOnError?: boolean }) {
  return desktopSequence(() => runDesktopBatch(input));
}
