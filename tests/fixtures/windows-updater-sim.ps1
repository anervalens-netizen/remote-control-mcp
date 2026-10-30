param([string]$Source,[string]$Node,[ValidateSet('success','rollback','conflict','active','delayed','stuck')][string]$Scenario)
$ErrorActionPreference='Stop'
$base=Join-Path ([IO.Path]::GetTempPath()) ('rc-updater-fixture-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($base)|Out-Null
$previousProgramData=$env:ProgramData;$env:ProgramData=$base
[IO.Directory]::CreateDirectory((Join-Path $base 'RemoteControlMCP\updater'))|Out-Null
try {
 $old='a'*40;$target='b'*40;$release=Join-Path $base 'releases';$repo=Join-Path $base 'repository'
 [IO.Directory]::CreateDirectory((Join-Path $release $target))|Out-Null
 [IO.Directory]::CreateDirectory((Join-Path $repo 'scripts'))|Out-Null
 [IO.File]::WriteAllText((Join-Path $repo 'scripts\verify-release.ts'),"console.log(JSON.stringify({ok:true,sha:'$target'}))")
 [IO.File]::WriteAllText((Join-Path (Join-Path $release $target) 'RELEASE.json'),('{"sourceSha":"'+$target+'"}'))
 $scriptPath=Join-Path $base 'candidate.ps1';$planPath=Join-Path $base 'plan.json';$receipt=Join-Path $base 'receipt.json'
 $global:rcFixture=@{tasks=@{};listeners=@{};records=@{};kills=@();scenario=$Scenario;old=$old;target=$target;node=$Node;starts=0}
 $agents=@()
 foreach($i in 1..2){
  $name='Fixture'+$i;$port=49000+$i;$procId=1000+$i;$created='2026-01-01T00:00:00.0000000Z'
  $oldCmd='"'+$Node+'" '+(Join-Path (Join-Path $release $old) 'apps\agent\src\index.ts')+' '
  $newCmd='"'+$Node+'" '+(Join-Path (Join-Path $release $target) 'apps\agent\src\index.ts')+' '
  $oa=@{execute='fixture.exe';arguments=('old-'+$i);workingDirectory=$null}
  $na=@{execute=(Join-Path $base 'fixture.exe');arguments=('new-'+$i);workingDirectory=$null}
  $s=@{name=$name;envFile=(Join-Path $base 'unused.env');context='system';port=$port;pid=$procId;created=$created;expectedCommand=$oldCmd;targetCommand=$newCmd;oldAction=$oa;targetAction=$na};$agents+=$s
  $global:rcFixture.tasks[$name]=@{State='Ready';Settings=@{Enabled=$true};Actions=@([pscustomobject]@{Execute=$oa.execute;Arguments=$oa.arguments;WorkingDirectory=$null})}
  $global:rcFixture.listeners[[string]$port]=@{pid=$procId;sha=$old;created=$created;command=$oldCmd}
 }
 $plan=@{version=1;oldSha=$old;targetSha=$target;releaseRoot=$release;repository=$repo;nodePath=$Node;agents=$agents}
 [IO.File]::WriteAllText($planPath,($plan|ConvertTo-Json -Depth 9),[Text.UTF8Encoding]::new($false))
 $overrides=@'
function IsIndependent {}
function NoActiveJobs($s) {if($global:rcFixture.scenario -eq 'active'){throw 'active jobs: fixture'};$state.lostJobs[$s.name]=@(@{id='synthetic-lost';state='lost'})}
function Get-ScheduledTask {param($TaskName)
 $t=$global:rcFixture.tasks[$TaskName]
 if($t.waiting){$t.waiting--;if($t.waiting -eq 0 -and $global:rcFixture.scenario -ne 'stuck'){$t.State='Ready'}}
 return $t
}
function New-ScheduledTaskAction {param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory}}
function Set-ScheduledTask {param($TaskName,$Action) $global:rcFixture.tasks[$TaskName].Actions=@($Action)}
function Disable-ScheduledTask {param($TaskName,$ErrorAction) $global:rcFixture.tasks[$TaskName].Settings.Enabled=$false}
function Enable-ScheduledTask {param($TaskName,$ErrorAction) $global:rcFixture.tasks[$TaskName].Settings.Enabled=$true}
function Start-ScheduledTask {param($TaskName)
 $s=$specs|Where-Object {$_.name -eq $TaskName}|Select-Object -First 1
 $a=$global:rcFixture.tasks[$TaskName].Actions[0];$isTarget=$a.Arguments -eq $s.targetAction.arguments
 $id=if($isTarget){2000+[int]$s.port-49000}else{3000+[int]$s.port-49000}
 $sha=if($isTarget){$target}else{$old};$cmd=if($isTarget){$s.targetCommand}else{$s.expectedCommand}
 $c=[DateTime]::UtcNow.ToString('o')
 $global:rcFixture.listeners[[string]$s.port]=@{pid=$id;sha=$sha;created=$c;command=$cmd}
 $global:rcFixture.records[[string]$id]=@{pid=$id;sha=$sha;created=$c;command=$cmd}
 $global:rcFixture.tasks[$TaskName].State='Running';$global:rcFixture.starts++
}
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction)
 foreach($k in $global:rcFixture.listeners.Keys){$v=$global:rcFixture.listeners[$k];if($v){[pscustomobject]@{OwningProcess=$v.pid;LocalPort=[int]$k}}}
 if($global:rcFixture.scenario -eq 'conflict' -and $global:rcFixture.kills.Count -ge 2){[pscustomobject]@{OwningProcess=9999;LocalPort=49001}}
}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction)
 $id=[int]($Filter -replace '^ProcessId=','');$v=$global:rcFixture.records[[string]$id]
 if(-not $v){return [pscustomobject]@{ProcessId=$id;ExecutablePath='unrelated.exe';CommandLine='other';CreationDate=[DateTime]::UtcNow}}
 return [pscustomobject]@{ProcessId=$id;ExecutablePath=$node;CommandLine=$v.command;CreationDate=[DateTime]::Parse($v.created)}
}
function Health($s,[string]$sha){$v=$global:rcFixture.listeners[[string]$s.port];if(-not $v -or $v.sha -ne $sha -or ($sha -eq $target -and $global:rcFixture.scenario -in @('rollback','delayed','stuck'))){throw 'synthetic health failure'}}
function Binding($s,[int]$id,[string]$created,[string]$sha,[bool]$checkHealth=$true){
 $v=$global:rcFixture.listeners[[string]$s.port];if(-not $v -or $v.pid -ne $id -or $v.created -cne $created -or $v.sha -ne $sha){throw 'binding mismatch'}
 if($checkHealth){Health $s $sha};return @{pid=$id;creation=$created;sha=$sha;port=$s.port}
}
function KillBound($s,$binding,[bool]$checkHealth=$true){
 $null=Binding $s $binding.pid $binding.creation $binding.sha $checkHealth
 if($global:rcFixture.tasks[$s.name].Settings.Enabled){throw 'task restart was not fenced'}
 $global:rcFixture.kills+=@($binding.pid);$global:rcFixture.listeners[[string]$s.port]=$null;if($binding.sha -eq $target -and $global:rcFixture.scenario -in @('delayed','stuck')){$global:rcFixture.tasks[$s.name].State='Running';$global:rcFixture.tasks[$s.name].waiting=3}else{$global:rcFixture.tasks[$s.name].State='Ready'}
}
'@
 $raw=[IO.File]::ReadAllText($Source);$marker="if(Test-Path -LiteralPath `$Receipt){throw 'receipt already exists; inspect it, do not replay'}"
 if(-not $raw.Contains($marker)){throw 'fixture insertion point missing'}
 $raw=$raw.Replace($marker,$overrides+[Environment]::NewLine+$marker).Replace('.AddSeconds(45)','.AddMilliseconds(20)').Replace('.AddSeconds(15)','.AddMilliseconds(900)')
 $raw=$raw.Replace("`$guardFile=Join-Path `$commonData 'RemoteControlMCP\updater\active.guard'","`$guardFile=Join-Path `$env:ProgramData 'RemoteControlMCP\updater\active.guard'")
 [IO.File]::WriteAllText($scriptPath,$raw,[Text.UTF8Encoding]::new($false))
 try{& $scriptPath -Mode apply -Plan $planPath -Receipt $receipt}catch{}
 $v=[IO.File]::ReadAllText($receipt)|ConvertFrom-Json
 $beforeInspect=[IO.File]::ReadAllText($receipt)
 $inspection=(& $scriptPath -Mode inspect -Receipt $receipt | Out-String)|ConvertFrom-Json
 $afterInspect=[IO.File]::ReadAllText($receipt)
 $replayRefused=$false;try{& $scriptPath -Mode apply -Plan $planPath -Receipt $receipt}catch{$replayRefused=$_.Exception.Message -match 'receipt already exists'}
 $guardRefused=$false;$beforeKills=$global:rcFixture.kills.Count
 if(Test-Path -LiteralPath (Join-Path $base 'RemoteControlMCP\updater\active.guard')){try{& $scriptPath -Mode apply -Plan $planPath -Receipt (Join-Path $base 'new-attempt.json')}catch{$guardRefused=$_.Exception.Message -match 'guard exists'}}
 @{guardRefused=$guardRefused;noAdditionalKills=($beforeKills -eq $global:rcFixture.kills.Count);scenario=$Scenario;phase=$v.phase;events=@($v.events|ForEach-Object {$_.phase});kills=$global:rcFixture.kills;lost=@($v.lostJobs.Fixture1).Count;guardRetained=(Test-Path -LiteralPath (Join-Path $base 'RemoteControlMCP\updater\active.guard'));inspectionPhase=$inspection.phase;inspectionUnchanged=($beforeInspect -ceq $afterInspect);replayRefused=$replayRefused;tasks=@($agents|ForEach-Object {@{name=$_.name;args=$global:rcFixture.tasks[$_.name].Actions[0].Arguments}})}|ConvertTo-Json -Compress -Depth 8
} finally {$env:ProgramData=$previousProgramData;Remove-Item -LiteralPath $base -Recurse -Force -ErrorAction SilentlyContinue}
