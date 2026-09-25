// Live interactive regression: opens a temporary textbox, checks native clipboard
// formats around two pastes, then restores the original clipboard and foreground.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { desktopBatch, closeDesktopHelper, desktopHelperStatus } from '../apps/agent/src/desktop.ts';
if (process.platform !== 'win32') throw new Error('Windows interactive owner context required');
const dir=await mkdtemp(path.join(tmpdir(),'rcmcp-desktop-live-'));
const ps=String.raw`param([string]$dir)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;public static class FixtureWindow {
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$foreground=[FixtureWindow]::GetForegroundWindow()
$source=[Windows.Forms.Clipboard]::GetDataObject()
$original=New-Object Windows.Forms.DataObject
$originalFormats=@()
if($source){
 $originalFormats=@($source.GetFormats($false))
 foreach($format in $originalFormats){
  $value=$source.GetData($format,$false)
  if($null -eq $value){throw 'Cannot snapshot original clipboard'}
  if($value -is [IO.Stream]){$copy=New-Object IO.MemoryStream;if($value.CanSeek){$value.Position=0};$value.CopyTo($copy);$copy.Position=0;$value=$copy}
  elseif($value -is [ICloneable]){$value=$value.Clone()}
  $original.SetData($format,$false,$value)
 }
}
$form=New-Object Windows.Forms.Form
$form.Text='RCMCP isolated typing validation';$form.Width=500;$form.Height=180
$box=New-Object Windows.Forms.TextBox;$box.Multiline=$true;$box.Dock='Fill';$form.Controls.Add($box)
# Accept paste only so unrelated physical typing cannot corrupt the fixture.
$box.Add_KeyDown({param($sender,$event) if(-not ($event.Control -and $event.KeyCode -eq [Windows.Forms.Keys]::V)){$event.SuppressKeyPress=$true;$event.Handled=$true}})
$box.Add_KeyPress({param($sender,$event) if([int]$event.KeyChar -ne 22){$event.Handled=$true}})
$timer=New-Object Windows.Forms.Timer;$timer.Interval=100
$start=[DateTime]::UtcNow
$fixture=New-Object Windows.Forms.DataObject
$fixture.SetData('UnicodeText',$false,'RCMCP_CLIPBOARD_SENTINEL')
$fixture.SetData('RCMCP.Persistent.Custom',$false,'native-custom-sentinel')
$bitmap=New-Object Drawing.Bitmap 2,2;$bitmap.SetPixel(0,0,[Drawing.Color]::Magenta)
$fixture.SetData('Bitmap',$false,$bitmap)
$result=$null
try {
 [Windows.Forms.Clipboard]::SetDataObject($fixture,$true)
 $expectedFormats=@([Windows.Forms.Clipboard]::GetDataObject().GetFormats($false)|Sort-Object)
 $form.Add_Shown({$form.Activate();$box.Focus();[Console]::WriteLine((@{ready=$true;pid=$PID;handle=[int64]$form.Handle}|ConvertTo-Json -Compress));[Console]::Out.Flush()})
 $timer.Add_Tick({
  if((Test-Path -LiteralPath (Join-Path $dir 'done')) -or ([DateTime]::UtcNow-$start).TotalSeconds -gt 30){$script:capturedText=$box.Text;$form.Close()}
 })
 $timer.Start();[Windows.Forms.Application]::Run($form);$timer.Stop()
 $after=[Windows.Forms.Clipboard]::GetDataObject()
 $formats=@($after.GetFormats($false)|Sort-Object)
 $image=$after.GetData('Bitmap',$false)
 $result=@{typed=$script:capturedText;formatsMatch=(($formats -join '|') -eq ($expectedFormats -join '|'));formatCount=$formats.Count;textMatch=($after.GetData('UnicodeText',$false) -eq 'RCMCP_CLIPBOARD_SENTINEL');customMatch=($after.GetData('RCMCP.Persistent.Custom',$false) -eq 'native-custom-sentinel');bitmapMatch=($image.GetPixel(0,0).ToArgb() -eq [Drawing.Color]::Magenta.ToArgb())}
} finally {
 $restored=$false
 for($attempt=0;$attempt -lt 10;$attempt++){
  try {if($originalFormats.Count){[Windows.Forms.Clipboard]::SetDataObject($original,$true)}else{[Windows.Forms.Clipboard]::Clear()};$restored=$true;break}catch{Start-Sleep -Milliseconds 80}
 }
 [void][FixtureWindow]::SetForegroundWindow($foreground)
 $timer.Dispose();$form.Dispose();$bitmap.Dispose()
 if(-not $restored){throw 'Original clipboard restore failed'}
}
$result.originalClipboardRestored=$true
[Console]::WriteLine(($result|ConvertTo-Json -Compress));[Console]::Out.Flush()
`;
let child: ReturnType<typeof spawn> | undefined;
try {
 const file=path.join(dir,'fixture.ps1');await writeFile(file,ps);
 child=spawn('powershell.exe',['-NoLogo','-NoProfile','-Sta','-ExecutionPolicy','Bypass','-File',file,dir],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr!.setEncoding('utf8');child.stderr!.on('data',d=>stderr+=d);
 const lines=createInterface({input:child.stdout!});const messages: Array<Record<string,unknown>>=[];
 let readyResolve:(value: number)=>void;let readyReject:(error:Error)=>void;
 const ready=new Promise<number>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 lines.on('line',line=>{try{const msg=JSON.parse(line);messages.push(msg);if(msg.ready)readyResolve(Number(msg.handle));}catch{}});
 const finished=new Promise<void>((resolve,reject)=>{child!.on('error',error=>{readyReject(error);reject(error)});child!.on('close',code=>{if(code===0){if(!messages.some(m=>m.ready))readyReject(new Error('Fixture exited before ready'));resolve()}else{const err=new Error('Fixture failed: '+stderr);readyReject(err);reject(err)}})});
 void finished.catch(()=>{});
 let result;
 try {
  const handle=await ready;
  result=await desktopBatch({actions:[{kind:'focus',handle},{kind:'keyboard',action:'type',text:'RCMCP Șță 😀 '},{kind:'keyboard',action:'type',text:'persistent'}]});
 } finally {await writeFile(path.join(dir,'done'),'done');}
 await finished;
 const verified=messages.find(m=>'originalClipboardRestored' in m)!;
 assert.equal(verified?.originalClipboardRestored,true);assert.equal(result?.ok,true,JSON.stringify(result));
 assert.equal(verified.typed,'RCMCP Șță 😀 persistent');
 for(const key of ['formatsMatch','textMatch','customMatch','bitmapMatch'])assert.equal(verified[key],true,key);
 console.log(JSON.stringify({ok:true,typedMatch:true,formats:verified.formatCount,originalClipboardRestored:true,helper:desktopHelperStatus()}));
} finally {closeDesktopHelper();await rm(dir,{recursive:true,force:true});}
