param()

function Update-RcmcpAgentEnv {
  param(
    [Parameter(Mandatory=$true)][string]$EnvFile,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$OwnerUser
  )

  if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Missing $EnvFile" }

  $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  $OriginalLines = @([IO.File]::ReadAllLines($EnvFile, $Utf8NoBom))
  $Lines = @($OriginalLines | Where-Object { $_ -notmatch '^(RCMCP_NODE_PATH|RCMCP_OWNER_USER)=' })
  $Lines += "RCMCP_NODE_PATH=$NodePath"
  $Lines += "RCMCP_OWNER_USER=$OwnerUser"

  # Same-volume temp + File.Replace is the commit boundary. Preserve the ACL
  # and retain a backup until replacement succeeds.
  $EnvTemp = "$EnvFile.rcmcp-$PID-$([Guid]::NewGuid().ToString('N')).tmp"
  $EnvBackup = "$EnvFile.rcmcp-$PID-$([Guid]::NewGuid().ToString('N')).bak"
  try {
    [IO.File]::WriteAllLines($EnvTemp, [string[]]$Lines, $Utf8NoBom)
    Set-Acl -LiteralPath $EnvTemp -AclObject (Get-Acl -LiteralPath $EnvFile)
    [IO.File]::Replace($EnvTemp, $EnvFile, $EnvBackup, $true)
  } catch {
    Remove-Item -LiteralPath $EnvTemp -Force -ErrorAction SilentlyContinue
    throw
  }

  # Replacement already committed. Cleanup failure must not cause callers to
  # replay the update.
  Remove-Item -LiteralPath $EnvBackup -Force -ErrorAction SilentlyContinue

  [pscustomobject]@{
    ok = $true
    envFile = $EnvFile
    ownerUser = $OwnerUser
    nodePath = $NodePath
  }
}
