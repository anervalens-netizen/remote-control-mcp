param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'updater parse failure'}
$type=$ast.Find({param($n)$n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)
$kill=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'KillBound'},$true)
$restore=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'RestoreAction'},$true)
if(-not $type -or -not $kill -or -not $restore){throw 'required primitive missing'}
Invoke-Expression $type.Extent.Text;Invoke-Expression $kill.Extent.Text;Invoke-Expression $restore.Extent.Text
function Binding($s,[int]$id,[string]$created,[string]$sha,[bool]$checkHealth=$true){
 if($id -ne $script:allowedPid){throw 'unexpected fixture PID'}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id"
 if(-not $p -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $created){throw 'fixture identity mismatch'}
 return @{pid=$id;creation=$created;sha=$sha}
}
function New-ScheduledTaskAction {param([string]$Execute,[string]$Argument,[string]$WorkingDirectory)
 $script:hasWorkingDirectory=$PSBoundParameters.ContainsKey('WorkingDirectory')
 return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory}
}
function Set-ScheduledTask {param([string]$TaskName,$Action) $script:fixtureAction=$Action}
function Get-ScheduledTask {param([string]$TaskName) return [pscustomobject]@{Actions=@($script:fixtureAction)}}
$targetProcess=$null;$control=$null
try {
 $targetProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep 120' -PassThru -WindowStyle Hidden
 $control=Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep 120' -PassThru -WindowStyle Hidden
 $script:allowedPid=$targetProcess.Id
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($targetProcess.Id)"
 $created=$p.CreationDate.ToUniversalTime().ToString('o');$wrong=$p.CreationDate.ToUniversalTime().AddSeconds(-1).ToString('o')
 $wrongRejected=$false;try{KillBound @{name='fixture'} @{pid=$targetProcess.Id;creation=$wrong;sha='fixture'} $false}catch{if($_.Exception.Message -match 'identity changed'){$wrongRejected=$true}else{throw}}
 $targetAlive=[bool](Get-Process -Id $targetProcess.Id -ErrorAction SilentlyContinue)
 KillBound @{name='fixture'} @{pid=$targetProcess.Id;creation=$created;sha='fixture'} $false
 $targetStopped=-not (Get-Process -Id $targetProcess.Id -ErrorAction SilentlyContinue)
 $controlAlive=[bool](Get-Process -Id $control.Id -ErrorAction SilentlyContinue)
 $state=@{before=@{fixture=@{execute='fixture.exe';arguments='fixture';workingDirectory=$null}}}
 RestoreAction @{name='fixture'};$nullOmitted=-not $script:hasWorkingDirectory
 $state.before.fixture.workingDirectory='C:\fixture';RestoreAction @{name='fixture'}
 $explicitKept=$script:hasWorkingDirectory -and $script:fixtureAction.WorkingDirectory -eq 'C:\fixture'
 @{wrongRejected=$wrongRejected;targetAlive=$targetAlive;targetStopped=$targetStopped;controlAlive=$controlAlive;nullOmitted=$nullOmitted;explicitKept=$explicitKept}|ConvertTo-Json -Compress
} finally {
 if($targetProcess -and -not $targetProcess.HasExited){$targetProcess.Kill();$targetProcess.WaitForExit()}
 if($control -and -not $control.HasExited){$control.Kill();$control.WaitForExit()}
}
