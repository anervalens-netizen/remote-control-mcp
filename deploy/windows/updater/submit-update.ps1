#Requires -RunAsAdministrator
# Register exactly one independent SYSTEM attempt. Existing task/receipt is
# evidence to inspect, not permission to launch the same operation again.
param(
 [Parameter(Mandatory=$true)][string]$TaskName,
 [Parameter(Mandatory=$true)][string]$Plan,
 [Parameter(Mandatory=$true)][string]$Receipt,
 [Parameter(Mandatory=$true)][string]$Runner,
 [Parameter(Mandatory=$true)][string]$RunnerSha256
)
$ErrorActionPreference='Stop'
if($TaskName -notmatch '^RCMCP-Update-[A-Za-z0-9-]{1,80}$'){throw 'invalid task name'}
foreach($p in @($Plan,$Receipt,$Runner)){if(-not [IO.Path]::IsPathRooted($p) -or $p.Contains('"')){throw 'absolute quote-free paths required'}}
if($RunnerSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Runner -Algorithm SHA256).Hash -ine $RunnerSha256){throw 'runner digest mismatch'}
if(-not [IO.File]::Exists($Plan)){throw 'plan not found'}
if([IO.File]::Exists($Receipt) -or (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)){throw 'task or receipt exists; inspect before proceeding'}
$arguments='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$Runner+'" -Mode apply -Plan "'+$Plan+'" -Receipt "'+$Receipt+'"'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -ErrorAction Stop|Out-Null
# If Start is uncertain, leave the task registered and inspect it and Receipt.
Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
@{task=$TaskName;receipt=$Receipt;started=$true;runnerSha256=$RunnerSha256;noReplay=$true}|ConvertTo-Json -Compress
