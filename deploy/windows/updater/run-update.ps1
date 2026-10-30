# Scheduled independently as SYSTEM. Inspect never dispatches or resumes effects.
param(
 [ValidateSet('inspect','dry-run','apply')][string]$Mode='inspect',
 [Parameter(Mandatory=$true)][string]$Receipt,
 [string]$Plan
)
$ErrorActionPreference='Stop'
if(-not [IO.Path]::IsPathRooted($Receipt)){throw 'absolute receipt path required'}
if($Mode -eq 'inspect') {
 if(-not [IO.File]::Exists($Receipt)){throw 'receipt not found'}
 [IO.File]::ReadAllText($Receipt)|ConvertFrom-Json|ConvertTo-Json -Depth 12
 return
}
if(-not $Plan -or -not [IO.Path]::IsPathRooted($Plan)){throw 'absolute plan path required'}
$planObject=[IO.File]::ReadAllText($Plan)|ConvertFrom-Json
if($planObject.version -ne 1){throw 'unsupported plan version'}
$old=[string]$planObject.oldSha;$target=[string]$planObject.targetSha
if($old -notmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' -or $target -notmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' -or $old.Length -ne $target.Length -or $old -eq $target){throw 'invalid release identity'}
$root=[string]$planObject.releaseRoot;$node=[string]$planObject.nodePath;$repository=[string]$planObject.repository
$commonData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
if(-not [IO.Path]::IsPathRooted($commonData)){throw 'common application data path unavailable'}
$guardFile=Join-Path $commonData 'RemoteControlMCP\updater\active.guard'
foreach($p in @($root,$node,$repository)){if(-not [IO.Path]::IsPathRooted($p)){throw 'absolute paths required'}}
$specs=@($planObject.agents)
if($specs.Count -lt 1 -or $specs.Count -gt 8){throw 'invalid agent count'}
$names=@{};$ports=@{};$pids=@{}
foreach($s in $specs){
 if(-not $s.name -or $names.ContainsKey([string]$s.name) -or [int]$s.port -lt 1 -or [int]$s.port -gt 65535 -or $ports.ContainsKey([string]$s.port) -or [int]$s.pid -le 0 -or $pids.ContainsKey([string]$s.pid)){throw 'duplicate or invalid agent binding'}
 if(-not [IO.Path]::IsPathRooted([string]$s.envFile) -or -not $s.context -or -not $s.created -or -not $s.targetCommand -or -not $s.expectedCommand -or -not $s.oldAction.execute -or -not $s.oldAction.arguments -or -not $s.targetAction.execute -or -not $s.targetAction.arguments){throw 'incomplete binding or task action'}
 if(-not [IO.Path]::IsPathRooted([string]$s.targetAction.execute)){throw 'target executable path must be absolute'}
 $oldIndex=Join-Path (Join-Path $root $old) 'apps\agent\src\index.ts'
 $targetIndex=Join-Path (Join-Path $root $target) 'apps\agent\src\index.ts'
 if(([string]$s.expectedCommand).IndexOf($oldIndex,[StringComparison]::OrdinalIgnoreCase) -lt 0 -or ([string]$s.targetCommand).IndexOf($targetIndex,[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'agent commands do not identify the expected releases'}
 $names[[string]$s.name]=$true;$ports[[string]$s.port]=$true;$pids[[string]$s.pid]=$true
}
$Apply=$Mode -eq 'apply'
if([IO.Path]::GetFullPath($guardFile) -ieq [IO.Path]::GetFullPath($Receipt)){throw 'guard and receipt paths must differ'}
$state=[ordered]@{version=1;oldSha=$old;targetSha=$target;mode=$Mode;phase='preflight';startedAt=[DateTime]::UtcNow.ToString('o');events=@();before=@{};candidateActions=@{};lostJobs=@{};bindings=@();rollback=@()}
# Same-directory atomic replace, flush file content, retain every completed phase.
function Save([string]$phase,[object]$detail=$null) {
 $state.phase=$phase;$state.events+=@{phase=$phase;at=[DateTime]::UtcNow.ToString('o');detail=$detail}
 $temp=$Receipt+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($state|ConvertTo-Json -Depth 12))
 $f=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$f.Write($bytes,0,$bytes.Length);$f.Flush($true)}finally{$f.Dispose()}
 if(Test-Path -LiteralPath $Receipt){$backup=$Receipt+'.'+[guid]::NewGuid().ToString('N')+'.bak';[IO.File]::Replace($temp,$Receipt,$backup)}else{[IO.File]::Move($temp,$Receipt)}
}
function Config($s) {
 $e=@{};Get-Content -LiteralPath $s.envFile|ForEach-Object{if($_ -match '^([^#=][^=]*)=(.*)$'){$e[$matches[1].Trim()]=$matches[2]}}
 $h=$e['RCMCP_AGENT_HOST'];if(-not $h -or $h -in @('0.0.0.0','::')){$h='127.0.0.1'}
 $p=$e['RCMCP_AGENT_PORT'];if(-not $p){$p=$s.port};if([int]$p -ne $s.port){throw "configured port changed: $($s.name)"}
 if(-not $e['RCMCP_AGENT_TOKEN']){throw "missing token: $($s.name)"}
 return @{base=('http://'+$h+':'+$p);headers=@{Authorization=('Bearer '+$e['RCMCP_AGENT_TOKEN'])}}
}
function Health($s,[string]$sha) {
 $c=Config $s;$v=Invoke-RestMethod -Uri ($c.base+'/health/details') -Headers $c.headers -TimeoutSec 4
 if($v.runtime.sha -ne $sha -or $v.runtime.ready -ne $true -or $v.runtime.context -ne $s.context){throw "health mismatch: $($s.name)"}
}
# History pages rather than latest-N; partial, corrupt or unreadable history fails closed.
# Lost receipts remain unresolved metadata; they are never replayed or altered.
function NoActiveJobs($s) {
 $c=Config $s
 foreach($kind in @('running','cancelling','lost')) {
  $cursor=$null;$seen=@{};$pages=0;$lost=@()
  do {
   $url=$c.base+'/v1/jobs/history?limit=1000&state='+$kind
   if($cursor){$url+='&cursor='+[Uri]::EscapeDataString($cursor)}
   $p=Invoke-RestMethod -Uri $url -Headers $c.headers -TimeoutSec 8
   foreach($field in @('items','partial','corruptCount','unavailableCount','unreadableCount','nextCursor')){if(-not $p.PSObject.Properties[$field]){throw 'job history response incomplete'}}
   if($p.partial -isnot [bool] -or $p.partial -or $p.corruptCount -or $p.unavailableCount -or $p.unreadableCount){throw "job history incomplete: $($s.name)"}
   if($kind -ne 'lost' -and @($p.items).Count -gt 0){throw "active jobs: $($s.name) ($kind)"}
   if($kind -eq 'lost'){$lost+=@($p.items|ForEach-Object {@{id=$_.id;state=$_.state;recoveryReason=$_.recoveryReason}})}
   $cursor=$p.nextCursor;if($cursor){if($seen.ContainsKey($cursor)){throw 'job history cursor repeated'};$seen[$cursor]=$true}
   if(++$pages -gt 1000){throw 'job history page bound exceeded'}
  }while($cursor)
  if($kind -eq 'lost'){$state.lostJobs[$s.name]=$lost}
 }
}
function Listeners($s) {
 # Query the provider with errors enabled; do not turn provider failure into an empty port.
 return @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -eq $s.port})
}
function Binding($s,[int]$id,[string]$created,[string]$sha,[bool]$checkHealth=$true) {
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
 if(-not $p -or $p.ExecutablePath -ine $node -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $created){throw "process identity mismatch: $($s.name)"}
 $expected=if($sha -eq $old){[string]$s.expectedCommand}else{[string]$s.targetCommand}
 if($p.CommandLine -cne $expected){throw "process command mismatch: $($s.name)"}
 $listeners=@(Listeners $s)
 if($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $id){throw "port ownership mismatch: $($s.name)"}
 if($checkHealth){Health $s $sha}
 return @{pid=$id;creation=$created;path=$p.ExecutablePath;command=$p.CommandLine;port=$s.port;sha=$sha}
}
function IsIndependent {
 # Trust only a live, identity-checked Schedule service ancestor. Windows may
 # retain a vanished boot-time parent beyond that service; it is not relevant.
 $svc=Get-CimInstance Win32_Service -Filter "Name='Schedule'" -ErrorAction Stop
 if(-not $svc -or $svc.State -ne 'Running' -or -not $svc.ProcessId){throw 'scheduler service unavailable'}
 $scheduler=Get-CimInstance Win32_Process -Filter "ProcessId=$($svc.ProcessId)" -ErrorAction Stop
 $expected=Join-Path $env:WINDIR 'System32\svchost.exe'
 if(-not $scheduler -or $scheduler.ExecutablePath -ine $expected -or $scheduler.CommandLine -notmatch '(?i)(?:^|\s)-s\s+Schedule(?:\s|$)'){throw 'scheduler process identity not proven'}
 $schedulerCreated=$scheduler.CreationDate.ToUniversalTime().Ticks
 $id=$PID;$seen=@{}
 while($id -and -not $seen.ContainsKey($id)) {
  if($id -in @($specs|ForEach-Object {[int]$_.pid})){throw 'apply is descended from an agent being stopped'}
  $seen[$id]=$true;$p=Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop
  if(-not $p){throw 'cannot establish helper ancestry before scheduler'}
  if($id -eq $svc.ProcessId){
   if($p.ExecutablePath -ine $expected -or $p.CreationDate.ToUniversalTime().Ticks -ne $schedulerCreated){throw 'scheduler identity changed'}
   $again=Get-CimInstance Win32_Service -Filter "Name='Schedule'" -ErrorAction Stop
   if($again.State -ne 'Running' -or $again.ProcessId -ne $id){throw 'scheduler service changed'}
   return
  }
  $id=[int]$p.ParentProcessId
 }
 throw 'helper does not descend from verified scheduler service'
}
# A single identity-checked kernel handle is retained through termination, so a
# recycled numeric PID cannot redirect the kill after the final check.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RCGuardProcess {
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr h, uint code);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
}
'@
function WaitTaskIdle($s) {
 $deadline=[DateTime]::UtcNow.AddSeconds(15)
 do{$task=Get-ScheduledTask -TaskName $s.name;if($task.State -in @('Ready','Disabled')){return};Start-Sleep -Milliseconds 250}while([DateTime]::UtcNow -lt $deadline)
 throw 'task wrapper remains active after bound agent exit'
}
function KillBound($s,$binding,[bool]$checkHealth=$true) {
 $h=[RCGuardProcess]::OpenProcess(0x101001,$false,[uint32]$binding.pid)
 if($h -eq [IntPtr]::Zero){throw 'cannot open process handle'}
 try {
  $create=0L;$exit=0L;$kernel=0L;$user=0L
  if(-not [RCGuardProcess]::GetProcessTimes($h,[ref]$create,[ref]$exit,[ref]$kernel,[ref]$user)){throw 'cannot read process handle identity'}
  # CIM truncates to microseconds; native FILETIME retains 100ns ticks.
  $actualTicks=[DateTime]::FromFileTimeUtc($create).Ticks
  $savedTicks=[DateTime]::Parse($binding.creation).ToUniversalTime().Ticks
  if(($actualTicks-($actualTicks % 10)) -ne $savedTicks){throw 'process handle identity changed'}
  $null=Binding $s $binding.pid $binding.creation $binding.sha $checkHealth
  if(-not [RCGuardProcess]::TerminateProcess($h,1)){throw 'bound process termination failed'}
  if([RCGuardProcess]::WaitForSingleObject($h,10000) -ne 0){throw "agent termination unconfirmed: $($s.name)"}
 } finally {[void][RCGuardProcess]::CloseHandle($h)}
}
function RestoreAction($s) {
 $b=$state.before[$s.name];$params=@{Execute=$b.execute;Argument=$b.arguments}
 if(-not [string]::IsNullOrEmpty($b.workingDirectory)){$params.WorkingDirectory=$b.workingDirectory}
 Set-ScheduledTask -TaskName $s.name -Action (New-ScheduledTaskAction @params)|Out-Null
 $a=(Get-ScheduledTask -TaskName $s.name).Actions
 if($a.Count -ne 1 -or $a[0].Execute -cne $b.execute -or $a[0].Arguments -cne $b.arguments -or [string]$a[0].WorkingDirectory -cne [string]$b.workingDirectory){throw "restore action mismatch: $($s.name)"}
}
function NoPort($s) {if(@(Listeners $s).Count){throw "port still occupied: $($s.port)"}}
function CompleteGuard {
 if(-not $Apply){return}
 if(-not [IO.File]::Exists($guardFile)){throw 'operation guard missing; inspect before proceeding'}
 if(([IO.File]::GetAttributes($guardFile) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'operation guard is a reparse point'}
 $g=[IO.File]::ReadAllText($guardFile)|ConvertFrom-Json
 if($g.receipt -cne $Receipt -or $g.plan -cne $Plan){throw 'operation guard changed'}
 [IO.File]::Delete($guardFile)
}
if(Test-Path -LiteralPath $Receipt){throw 'receipt already exists; inspect it, do not replay'}
if(-not (Test-Path -LiteralPath (Split-Path -Parent $Receipt))){throw 'receipt directory missing'}
if(-not (Test-Path -LiteralPath (Split-Path -Parent $guardFile))){throw 'private updater guard directory missing'}
if([IO.File]::Exists($guardFile)){throw 'previous operation guard exists; inspect before proceeding'}
# A global mutex prevents two updater processes from mutating concurrently.
# An abandoned owner is uncertain: inspect the retained receipt, never replay.
$mutex=$null
if($Apply){
 $mutex=[Threading.Mutex]::new($false,'Global\RemoteControlMCP.AgentUpgrade')
 try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{throw 'previous updater abandoned its lock; inspect receipts'}
 if(-not $acquired){throw 'another updater is active'}
 # This survives a dead runner even after its named mutex disappears. Only a
 # verified terminal receipt permits removal. Never replace an existing guard.
 $guard=[IO.File]::Open($guardFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
 try {
  $raw=[Text.UTF8Encoding]::new($false).GetBytes((@{version=1;receipt=$Receipt;plan=$Plan}|ConvertTo-Json -Compress))
  $guard.Write($raw,0,$raw.Length);$guard.Flush($true)
 } finally {$guard.Dispose()}
}

Save 'preflight_started'
try {
 $verifier=Join-Path $repository 'scripts\verify-release.ts'
 $release=Join-Path $root $target
 $proof=& $node $verifier $repository $release $target
 if($LASTEXITCODE -ne 0){throw 'release attestation failed'}
 $verified=($proof -join [Environment]::NewLine)|ConvertFrom-Json
 if(-not $verified.ok -or $verified.sha -cne $target){throw 'release attestation identity mismatch'}
 $manifest=Get-Content -LiteralPath (Join-Path (Join-Path $root $target) 'RELEASE.json') -Raw|ConvertFrom-Json
 if($manifest.sourceSha -ne $target){throw 'candidate release identity mismatch'}
 foreach($s in $specs){
  $t=Get-ScheduledTask -TaskName $s.name
  if($t.State -notin @('Ready','Running') -or $t.Settings.Enabled -ne $true -or $t.Actions.Count -ne 1 -or $t.Actions[0].Execute -cne $s.oldAction.execute -or $t.Actions[0].Arguments -cne $s.oldAction.arguments -or [string]$t.Actions[0].WorkingDirectory -cne [string]$s.oldAction.workingDirectory){throw "task not in expected state: $($s.name)"}
  $a=$t.Actions[0];$state.before[$s.name]=@{execute=$a.Execute;arguments=$a.Arguments;workingDirectory=$a.WorkingDirectory;wasRunning=($t.State -eq 'Running')}
  NoActiveJobs $s
  $state.bindings+=Binding $s $s.pid $s.created $old
 }
 Save 'preflight_passed' @{note='No admission fence exists; concurrent new work remains an external coordination requirement.'}
 if(-not $Apply){return}
 IsIndependent
 Save 'independent_control_verified'
} catch {
 $state.failure=$_.Exception.Message
 Save 'failed_before_effect'
 CompleteGuard
 throw
}
$effectsStarted=$false
try {
 foreach($s in $specs){NoActiveJobs $s;$null=Binding $s $s.pid $s.created $old}
 foreach($s in $specs){
  Save 'before_task_disable' @{task=$s.name};$effectsStarted=$true
  Disable-ScheduledTask -TaskName $s.name -ErrorAction Stop|Out-Null
  if((Get-ScheduledTask -TaskName $s.name).Settings.Enabled -ne $false){throw 'task disable readback mismatch'}
  Save 'before_task_action' @{task=$s.name}
  $params=@{Execute=[string]$s.targetAction.execute;Argument=[string]$s.targetAction.arguments}
  if(-not [string]::IsNullOrEmpty([string]$s.targetAction.workingDirectory)){$params.WorkingDirectory=[string]$s.targetAction.workingDirectory}
  Set-ScheduledTask -TaskName $s.name -Action (New-ScheduledTaskAction @params)|Out-Null
  $a=(Get-ScheduledTask -TaskName $s.name).Actions
  if($a.Count -ne 1 -or $a[0].Execute -cne $s.targetAction.execute -or $a[0].Arguments -cne $s.targetAction.arguments -or [string]$a[0].WorkingDirectory -cne [string]$s.targetAction.workingDirectory){throw 'candidate action readback mismatch'}
  $state.candidateActions[$s.name]=@{execute=$a[0].Execute;arguments=$a[0].Arguments;workingDirectory=$a[0].WorkingDirectory}
 }
 foreach($s in $specs){
  NoActiveJobs $s; $binding=Binding $s $s.pid $s.created $old
  Save 'before_old_process_stop' @{task=$s.name;pid=$binding.pid;creation=$binding.creation}
  KillBound $s $binding;NoPort $s
  # The task's wrapper should exit after its bound child; never stop a whole
  # task instance because that could kill an unrelated or ambiguous process.
  if($state.before[$s.name].wasRunning){WaitTaskIdle $s}
 }
 foreach($s in $specs){
  NoPort $s;Save 'before_candidate_task_enable' @{task=$s.name};Enable-ScheduledTask -TaskName $s.name -ErrorAction Stop|Out-Null
  if((Get-ScheduledTask -TaskName $s.name).Settings.Enabled -ne $true){throw 'task enable readback mismatch'}
  NoPort $s;Save 'before_candidate_task_start' @{task=$s.name};Start-ScheduledTask -TaskName $s.name
 }
 $deadline=[DateTime]::UtcNow.AddSeconds(45)
 do{$ready=$true;foreach($s in $specs){try{Health $s $target}catch{$ready=$false}};if(-not $ready){Start-Sleep -Milliseconds 500}}while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
 if(-not $ready){throw 'candidate health timed out'}
 foreach($s in $specs){$ls=@(Listeners $s);if($ls.Count -ne 1){throw 'candidate listener ambiguous'};$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ls[0].OwningProcess)";$b=Binding $s $p.ProcessId $p.CreationDate.ToUniversalTime().ToString('o') $target;$state.bindings+=$b}
 Save 'candidate_verified'
 CompleteGuard
} catch {
 $state.failure=$_.Exception.Message
 if(-not $effectsStarted){Save 'failed_before_effect';CompleteGuard;throw}
 try {
  # Validate that each task action has not changed independently before restoring it.
  foreach($s in $specs){
   $a=(Get-ScheduledTask -TaskName $s.name).Actions;$expected=$state.candidateActions[$s.name]
   if(-not $expected){$expected=$state.before[$s.name]}
   if($a.Count -ne 1 -or $a[0].Execute -cne $expected.execute -or $a[0].Arguments -cne $expected.arguments -or [string]$a[0].WorkingDirectory -cne [string]$expected.workingDirectory){throw 'task action changed concurrently'}
  }
  foreach($s in $specs){
   Save 'before_rollback_task_disable' @{task=$s.name};Disable-ScheduledTask -TaskName $s.name -ErrorAction Stop|Out-Null
   if((Get-ScheduledTask -TaskName $s.name).Settings.Enabled -ne $false){throw 'rollback task disable readback mismatch'}
  }
  foreach($s in $specs){Save 'before_rollback_action_restore' @{task=$s.name};RestoreAction $s}
  # Refuse to kill any process unless its port, command, creation and target
  # path, creation time, port and recorded task action identify the candidate.
  # Health need not be ready during rollback. Unexpected ports fail closed.
  foreach($s in $specs){
   $ls=@(Listeners $s)
   if($ls.Count -gt 1){throw "rollback listener ambiguous: $($s.port)"}
   if($ls.Count -eq 0){
    $unknown=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object {$_.ExecutablePath -ieq $node -and $_.CommandLine -ceq $s.targetCommand})
    if($unknown.Count){throw 'candidate process exists without a bound listener; inspect manually'}
    if((Get-ScheduledTask -TaskName $s.name).State -eq 'Running'){throw 'candidate task still running without a bound listener'}
   }
   if($ls.Count -eq 1){
    if($ls[0].OwningProcess -eq $s.pid){$null=Binding $s $s.pid $s.created $old;continue}
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ls[0].OwningProcess)"
    if(-not $state.candidateActions.ContainsKey($s.name)){throw 'candidate task action was not established'}
    if($p.CreationDate.ToUniversalTime() -lt [DateTime]::Parse($state.startedAt).ToUniversalTime()){throw 'candidate process predates attempt'}
    $b=Binding $s $p.ProcessId $p.CreationDate.ToUniversalTime().ToString('o') $target $false
    Save 'before_candidate_process_stop' @{task=$s.name;pid=$b.pid;creation=$b.creation}
    KillBound $s $b $false;NoPort $s;WaitTaskIdle $s
   }
  }
  foreach($s in $specs){
   $ls=@(Listeners $s)
   Save 'before_old_task_enable' @{task=$s.name};Enable-ScheduledTask -TaskName $s.name -ErrorAction Stop|Out-Null
   if((Get-ScheduledTask -TaskName $s.name).Settings.Enabled -ne $true){throw 'rollback task enable readback mismatch'}
   if(-not $ls.Count){NoPort $s;Save 'before_old_task_start' @{task=$s.name};Start-ScheduledTask -TaskName $s.name}
  }
  $deadline=[DateTime]::UtcNow.AddSeconds(45)
  do{$ready=$true;foreach($s in $specs){try{Health $s $old}catch{$ready=$false}};if(-not $ready){Start-Sleep -Milliseconds 500}}while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if(-not $ready){throw 'rollback health timed out'}
  foreach($s in $specs){
   $ls=@(Listeners $s)
   if($ls.Count -ne 1){throw 'rollback listener ambiguous'}
   $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ls[0].OwningProcess)"
   $state.rollback+=Binding $s $p.ProcessId $p.CreationDate.ToUniversalTime().ToString('o') $old
  }
  Save 'rollback_health_verified'
  CompleteGuard
 } catch {$state.rollback+=@{error=$_.Exception.Message};Save 'rollback_incomplete'}
 throw
}
