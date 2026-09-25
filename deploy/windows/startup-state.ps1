# Side-effect-free on import. Paths are resolved from the configured owner, never
# the elevated account running uninstall. Manifest contains no credentials.
function Get-RcmcpStartupState([string]$OwnerProfile) {
  if ([string]::IsNullOrWhiteSpace($OwnerProfile)) { throw 'OwnerProfile is required' }
  $startup = Join-Path $OwnerProfile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
  $backup = Join-Path $OwnerProfile 'AppData\Local\RemoteControlMCP\backups\startup'
  return [pscustomobject]@{
    version = 1
    ownerProfile = $OwnerProfile
    userHost = Join-Path $startup 'remote-control-mcp-agent.cmd'
    backup = Join-Path $backup 'remote-control-mcp-agent.cmd.disabled-system'
  }
}
function Save-RcmcpStartupState([string]$StateFile, $State) {
  $parent = Split-Path $StateFile -Parent
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temp = Join-Path $parent ('.rcmcp-install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::WriteAllText($temp, ($State | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($StateFile)) { [IO.File]::Replace($temp, $StateFile, $null) }
    else { [IO.File]::Move($temp, $StateFile) }
  } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Read-RcmcpStartupState([string]$StateFile) {
  if (-not [IO.File]::Exists($StateFile)) { return $null }
  $state = [IO.File]::ReadAllText($StateFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($state.version -ne 1 -or -not $state.ownerProfile) { throw 'Invalid Remote Control MCP install-state manifest' }
  # Derive the file names rather than trusting arbitrary manifest paths.
  return Get-RcmcpStartupState $state.ownerProfile
}
function Restore-RcmcpStartupState($State) {
  if (-not $State) { throw 'Owner startup state is unavailable; original launcher was not modified' }
  $hostPath = [string]$State.userHost
  $backup = [string]$State.backup
  $legacy = $hostPath + '.disabled-system'
  if ([IO.File]::Exists($hostPath)) {
    return [pscustomobject]@{ restored = $false; alreadyPresent = $true; path = $hostPath }
  }
  if (-not [IO.File]::Exists($backup) -and [IO.File]::Exists($legacy)) { $backup = $legacy }
  if (-not [IO.File]::Exists($backup)) {
    return [pscustomobject]@{ restored = $false; backupMissing = $true; path = $hostPath }
  }
  [IO.Directory]::CreateDirectory((Split-Path $hostPath -Parent)) | Out-Null
  [IO.File]::Move($backup, $hostPath)
  return [pscustomobject]@{ restored = $true; path = $hostPath }
}
