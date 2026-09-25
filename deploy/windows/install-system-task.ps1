#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $Repo '.env.agent'
if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile" }
$Node = (Get-Command node.exe -ErrorAction Stop).Source
. (Join-Path $PSScriptRoot 'update-agent-env.ps1')
. (Join-Path $PSScriptRoot 'startup-state.ps1')
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OriginalLines = @([IO.File]::ReadAllLines($EnvFile, $Utf8NoBom))
$ConfiguredOwner = ($OriginalLines | Where-Object { $_ -match '^RCMCP_OWNER_USER=' } | Select-Object -Last 1) -replace '^RCMCP_OWNER_USER=', ''
$CurrentUser = [string]$env:USERNAME
$InteractiveAccount = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName

function Get-RcmcpAccountLeaf([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
  $separator = $Value.LastIndexOf('\')
  if ($separator -ge 0) { return $Value.Substring($separator + 1) }
  return $Value
}
function Test-RcmcpOwnerCandidate([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
  return $Value -ne 'SYSTEM' -and -not $Value.EndsWith('$')
}

$CurrentOwnerCandidate = Get-RcmcpAccountLeaf $CurrentUser
$ConfiguredOwnerCandidate = Get-RcmcpAccountLeaf $ConfiguredOwner
$InteractiveOwnerCandidate = Get-RcmcpAccountLeaf $InteractiveAccount
if (Test-RcmcpOwnerCandidate $ConfiguredOwnerCandidate) {
  $OwnerUser = $ConfiguredOwnerCandidate
} elseif (Test-RcmcpOwnerCandidate $InteractiveOwnerCandidate) {
  $OwnerUser = $InteractiveOwnerCandidate
} elseif (Test-RcmcpOwnerCandidate $CurrentOwnerCandidate) {
  $OwnerUser = $CurrentOwnerCandidate
} else {
  throw 'Unable to resolve the owner user while installing the SYSTEM agent'
}
$OwnerProfile = Get-CimInstance Win32_UserProfile |
  Where-Object { $_.LocalPath -and (Split-Path $_.LocalPath -Leaf) -ieq $OwnerUser } |
  Select-Object -First 1 -ExpandProperty LocalPath
if (-not $OwnerProfile) { throw "Unable to resolve profile path for owner $OwnerUser" }

Update-RcmcpAgentEnv -EnvFile $EnvFile -NodePath $Node -OwnerUser $OwnerUser | Out-Null

# Disable only the old user-session host agent. The desktop agent remains interactive
# on 45232 by design and is intentionally left in Startup. Resolve both paths from
# the owner profile so self-upgrade works from SYSTEM/session 0 as well.
$Startup = Join-Path $OwnerProfile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
$UserHost = Join-Path $Startup 'remote-control-mcp-agent.cmd'
$BackupDir = Join-Path $OwnerProfile 'AppData\Local\RemoteControlMCP\backups\startup'
$UserHostBackup = Join-Path $BackupDir 'remote-control-mcp-agent.cmd.disabled-system'
$StateFile = Join-Path $env:ProgramData 'RemoteControlMCP\install-state.json'
Save-RcmcpStartupState -StateFile $StateFile -State (Get-RcmcpStartupState $OwnerProfile)
if (Test-Path $UserHost) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  Move-Item -Force $UserHost $UserHostBackup
}
# Older installers placed the disabled backup inside Startup, which makes
# Explorer try to open the unknown .disabled-system extension at every logon.
$LegacyBackup = "$UserHost.disabled-system"
if (Test-Path $LegacyBackup) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  Move-Item -Force $LegacyBackup $UserHostBackup
}

# Free the host-agent port if the old user-mode process is still alive.
$Listener = Get-NetTCPConnection -LocalPort 45231 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($Listener) {
  $Proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($Proc -and $Proc.CommandLine -match 'remote-control-mcp.*apps\\agent\\src\\index\.ts') {
    Stop-Process -Id $Listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  } else {
    throw "Port 45231 is occupied by an unexpected process (PID $($Listener.OwningProcess)); refusing to kill it."
  }
}

$Launcher = Join-Path $PSScriptRoot 'start-agent.ps1'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`" -RuntimeContext system"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances Parallel -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'RemoteControlMCPAgent' -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName 'RemoteControlMCPAgent'

$AgentVerificationTimeoutSeconds = 135
$deadline = (Get-Date).AddSeconds($AgentVerificationTimeoutSeconds)
do {
  Start-Sleep -Milliseconds 300
  $Listener = Get-NetTCPConnection -LocalPort 45231 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} until ($Listener -or (Get-Date) -ge $deadline)
if (-not $Listener) {
  Stop-ScheduledTask -TaskName 'RemoteControlMCPAgent' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'RemoteControlMCPAgent' -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $UserHostBackup) { Move-Item -Force $UserHostBackup $UserHost }
  throw "SYSTEM agent did not bind port 45231 within $AgentVerificationTimeoutSeconds seconds; SYSTEM task was removed and user startup entry was restored."
}
$Proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)" -ErrorAction SilentlyContinue
$Owner = if ($Proc) { Invoke-CimMethod -InputObject $Proc -MethodName GetOwner -ErrorAction SilentlyContinue } else { $null }
[pscustomobject]@{
  ok = $true
  task = 'RemoteControlMCPAgent'
  state = (Get-ScheduledTask -TaskName 'RemoteControlMCPAgent').State
  pid = $Listener.OwningProcess
  owner = if ($Owner) { "$($Owner.Domain)\$($Owner.User)" } else { $null }
  port = 45231
  desktopStartupPreserved = (Test-Path (Join-Path $Startup 'remote-control-mcp-desktop.cmd'))
} | Format-List
