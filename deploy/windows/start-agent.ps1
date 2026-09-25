param([string]$EnvFileName = '.env.agent', [string]$RuntimeContext = '')
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EnvFile = Join-Path $Repo $EnvFileName
if (-not (Test-Path $EnvFile)) { throw "Missing $EnvFile" }
Get-Content $EnvFile | ForEach-Object {
  if ($_ -match '^([^#=][^=]*)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], 'Process')
  }
}
if ($RuntimeContext) { $env:RCMCP_RUNTIME_CONTEXT = $RuntimeContext }
elseif ($env:RCMCP_DESKTOP_ENABLED -eq '1') { $env:RCMCP_RUNTIME_CONTEXT = 'desktop' }
if (-not $env:RCMCP_OWNER_USER -and $env:USERNAME -and $env:USERNAME -ne 'SYSTEM') { $env:RCMCP_OWNER_USER = $env:USERNAME }

# A SYSTEM startup task can run before Tailscale has assigned its address. If the
# agent is configured to bind a specific local IP, wait for that IP to exist
# instead of exiting immediately and relying on a later interactive login.
$BindHost = $env:RCMCP_AGENT_HOST
if ($BindHost -and $BindHost -notin @('0.0.0.0', '::', '127.0.0.1', 'localhost', '::1')) {
  $ParsedIp = $null
  if ([System.Net.IPAddress]::TryParse($BindHost, [ref]$ParsedIp)) {
    $deadline = (Get-Date).AddMinutes(2)
    do {
      $localIp = Get-NetIPAddress -IPAddress $BindHost -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($localIp) { break }
      Start-Sleep -Seconds 1
    } until ((Get-Date) -ge $deadline)
    if (-not $localIp) { throw "Configured agent bind address $BindHost is not assigned after 120 seconds" }
  }
}

$Node = $env:RCMCP_NODE_PATH
if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
Set-Location $Repo
& $Node (Join-Path $Repo 'apps\agent\src\index.ts')
exit $LASTEXITCODE
