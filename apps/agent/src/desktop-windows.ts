export const windowsPrelude = String.raw`
if (-not ("RcmcpWindows" -as [type])) { Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RcmcpWindows {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  public class Bounds { public int x,y,width,height; }
  public class Window {
    public long handle,ownerHandle; public uint pid; public string title,className;
    public bool visible,minimized,rectAvailable; public Bounds rect; public int zOrder;
  }
  public static Window[] List() {
    var result = new List<Window>();
    if (!EnumWindows(delegate(IntPtr h, IntPtr parameter) {
      uint pid; GetWindowThreadProcessId(h,out pid);
      var title = new StringBuilder(GetWindowTextLength(h)+1); GetWindowText(h,title,title.Capacity);
      var cls = new StringBuilder(256); GetClassName(h,cls,cls.Capacity);
      Rect r; bool available = GetWindowRect(h,out r);
      result.Add(new Window { handle=h.ToInt64(), ownerHandle=GetWindow(h,4).ToInt64(),pid=pid,
        title=title.ToString(),className=cls.ToString(),visible=IsWindowVisible(h),minimized=IsIconic(h),
        rectAvailable=available,rect=new Bounds{x=r.Left,y=r.Top,width=r.Right-r.Left,height=r.Bottom-r.Top},zOrder=result.Count });
      return true;
    },IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return result.ToArray();
  }
}
'@ }
`;
export const windowsScript = windowsPrelude + String.raw`
$i=Get-Content -Raw -Encoding UTF8 -LiteralPath $args[0]|ConvertFrom-Json
$processes=@{}
$out=@(foreach($window in [RcmcpWindows]::List()){
  if(-not $i.includeHidden -and -not $window.visible){continue}
  if($null -ne $i.pid -and $window.pid -ne $i.pid){continue}
  if($null -ne $i.title -and $window.title.IndexOf([string]$i.title,[StringComparison]::OrdinalIgnoreCase) -lt 0){continue}
  $processKey=[int]$window.pid
  if(-not $processes.ContainsKey($processKey)){
    $metadata=@{name=$null;sessionId=$null}
    try{
      $p=Get-Process -Id $processKey -ErrorAction Stop
      $name=$p.ProcessName;$sessionId=$p.SessionId
      $metadata=@{name=$name;sessionId=$sessionId}
    }catch{}
    $processes[$processKey]=$metadata
  }
  [pscustomobject]@{handle=$window.handle;ownerHandle=$window.ownerHandle;pid=$window.pid;process=$processes[$processKey].name;sessionId=$processes[$processKey].sessionId;title=$window.title;className=$window.className;visible=$window.visible;minimized=$window.minimized;rect=$window.rect;rectAvailable=$window.rectAvailable;zOrder=$window.zOrder}
})
ConvertTo-Json -InputObject $out -Compress -Depth 6
`;
