#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
. (Join-Path $PSScriptRoot 'startup-state.ps1')
$StateFile = Join-Path $env:ProgramData 'RemoteControlMCP\install-state.json'
$State = Read-RcmcpStartupState $StateFile
if (-not $State) {
  # Compatibility with installations made before the owner manifest existed.
  $EnvFile = Join-Path $Repo '.env.agent'
  $OwnerUser = (([IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -match '^RCMCP_OWNER_USER=' } | Select-Object -Last 1) -replace '^RCMCP_OWNER_USER=', '')
  if ([string]::IsNullOrWhiteSpace($OwnerUser)) { throw 'Configured owner is missing; no startup entry was changed' }
  $OwnerUser = ($OwnerUser -split '\\')[-1]
  $OwnerProfile = Get-CimInstance Win32_UserProfile |
    Where-Object { $_.LocalPath -and (Split-Path $_.LocalPath -Leaf) -ieq $OwnerUser } |
    Select-Object -First 1 -ExpandProperty LocalPath
  if (-not $OwnerProfile) { throw "Unable to resolve owner profile for $OwnerUser" }
  $State = Get-RcmcpStartupState $OwnerProfile
}
# Resolve recovery before removing the service, and never modify desktop startup.
$Task = Get-ScheduledTask -TaskName 'RemoteControlMCPAgent' -ErrorAction SilentlyContinue
if ($Task) {
  Stop-ScheduledTask -TaskName 'RemoteControlMCPAgent'
  Unregister-ScheduledTask -TaskName 'RemoteControlMCPAgent' -Confirm:$false
}
$Restored = Restore-RcmcpStartupState $State
[pscustomobject]@{ taskRemoved = $true; startup = $Restored; ownerProfile = $State.ownerProfile } | ConvertTo-Json -Depth 4
