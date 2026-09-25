import { expect,it } from "vitest";
import { DesktopHelper,desktopHelperPowerShell } from "../apps/agent/src/desktop-helper.ts";
import { uiaScript } from "../apps/agent/src/desktop-uia.ts";
import { windowsScript } from "../apps/agent/src/desktop-windows.ts";
it.skipIf(process.platform!=="win32" || process.env.RCMCP_TEST_INTERACTIVE === "0")("binds native UIA property identifiers and retains windows when process metadata disappears",async()=>{
  const helper=new DesktopHelper("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-Sta","-EncodedCommand",Buffer.from(desktopHelperPowerShell,"utf16le").toString("base64")]);
  const memory=(s:string)=>s.replace(/Get-Content -Raw -Encoding UTF8 -LiteralPath \$args\[0\]\s*\|\s*ConvertFrom-Json/g,"$RcmcpInput");
  try{
    const setup=memory(uiaScript.slice(0,uiaScript.indexOf("if($i.elementId){")));
    const result=await helper.request(setup+"\n$values=@('Name','AutomationElement.NameProperty','AutomationElementIdentifiers.NameProperty',30005,@{id=30005},@{name='NameProperty'})\n$ids=@(foreach($value in $values){(Convert-Argument $value ([System.Windows.Automation.AutomationProperty])).Id})\nConvertTo-Json -InputObject $ids -Compress\n",{});
    expect(result).toEqual([30005,30005,30005,30005,30005,30005]);
    const windows=await helper.request("\nfunction Get-Process {\n  param($Id,$ErrorAction)\n  $p=[pscustomobject]@{}\n  $p|Add-Member -MemberType ScriptProperty -Name ProcessName -Value {throw 'process exited during enrichment'}\n  $p|Add-Member -MemberType ScriptProperty -Name SessionId -Value {throw 'process exited during enrichment'}\n  return $p\n}\n"+memory(windowsScript),{includeHidden:true}) as Array<{process:unknown;sessionId:unknown}>;
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.every(w=>w.process===null&&w.sessionId===null)).toBe(true);
  }finally{helper.close()}
},15000);
