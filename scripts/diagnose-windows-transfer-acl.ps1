$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('rcmcp-acl-diagnostic-' + [Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $root | Out-Null
try {
  $private = Join-Path $root 'private'
  New-Item -ItemType Directory -Path $private | Out-Null
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl -LiteralPath $private -AclObject $acl
  $source = Join-Path $root 'source'
  [IO.File]::WriteAllText((Join-Path $private 'payload'),'fixture')
  [IO.File]::Move((Join-Path $private 'payload'),$source)
  $original = Get-Acl -LiteralPath $source
  Write-Output ('EXPECTED ' + $original.Sddl)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RcAclDiagnostic {
 [DllImport("advapi32.dll",EntryPoint="SetFileSecurityW",CharSet=CharSet.Unicode,SetLastError=true)]
 public static extern bool Set(string path, uint info, byte[] descriptor);
}
'@
  foreach ($method in @('set-acl','fresh','native7','native-unprotected')) {
    $target=Join-Path $root $method; [IO.File]::WriteAllText($target,'fixture')
    if ($method -eq 'set-acl') { Set-Acl -LiteralPath $target -AclObject $original }
    elseif ($method -eq 'fresh') {
      $copy=New-Object Security.AccessControl.FileSecurity
      $copy.SetSecurityDescriptorBinaryForm($original.GetSecurityDescriptorBinaryForm())
      [IO.File]::SetAccessControl($target,$copy)
    } else {
      [uint32]$flags=7
      if ($method -eq 'native-unprotected') { $flags=$flags -bor 0x20000000 }
      if (-not [RcAclDiagnostic]::Set($target,$flags,$original.GetSecurityDescriptorBinaryForm())) { throw ('Native failure '+[Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    }
    Write-Output ($method + ' ' + (Get-Acl -LiteralPath $target).Sddl)
  }
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
