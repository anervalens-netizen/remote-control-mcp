import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const startAgent = path.resolve("deploy/windows/start-agent.ps1");
const installTask = path.resolve("deploy/windows/install-system-task.ps1");
const updateEnv = path.resolve("deploy/windows/update-agent-env.ps1");

function source(file: string) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

describe("Windows startup recovery regressions", () => {
  it("waits for a configured bind IP before launching the agent", () => {
    const script = source(startAgent);
    const bind = script.indexOf("$BindHost = $env:RCMCP_AGENT_HOST");
    const probe = script.indexOf("Get-NetIPAddress -IPAddress $BindHost");
    const deadline = script.indexOf(".AddMinutes(2)");
    const launch = script.indexOf("& $Node (Join-Path $Repo 'apps\\agent\\src\\index.ts')");
    expect(bind).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(bind);
    expect(deadline).toBeGreaterThan(bind);
    expect(script).toContain("Configured agent bind address $BindHost is not assigned after 120 seconds");
    expect(launch).toBeGreaterThan(probe);
  });

  it("allows a replacement SYSTEM instance while self-upgrade installer is still running", () => {
    const script = source(installTask);
    expect(script).toContain("-MultipleInstances Parallel");
    const settings = script.indexOf("-MultipleInstances Parallel");
    const register = script.indexOf("Register-ScheduledTask -TaskName 'RemoteControlMCPAgent'");
    const start = script.indexOf("Start-ScheduledTask -TaskName 'RemoteControlMCPAgent'");
    expect(settings).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(settings);
    expect(start).toBeGreaterThan(register);
  });

  it("lets the installer wait longer than the launcher bind-IP recovery window", () => {
    const script = source(installTask);
    expect(script).toContain("$AgentVerificationTimeoutSeconds = 135");
    expect(script).toContain(".AddSeconds($AgentVerificationTimeoutSeconds)");
    expect(script).toContain("within $AgentVerificationTimeoutSeconds seconds");
    expect(script).not.toContain(".AddSeconds(15)");
  });

  it("resolves owner identity and Startup paths correctly when invoked from SYSTEM", () => {
    const script = source(installTask);
    expect(script).toContain("Get-CimInstance Win32_ComputerSystem");
    expect(script).toContain("Get-CimInstance Win32_UserProfile");
    expect(script).toContain("Update-RcmcpAgentEnv -EnvFile $EnvFile -NodePath $Node -OwnerUser $OwnerUser");
    expect(source(updateEnv)).toContain('"RCMCP_OWNER_USER=$OwnerUser"');
    expect(script).toContain("$Startup = Join-Path $OwnerProfile 'AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'");
    expect(script).toContain("$BackupDir = Join-Path $OwnerProfile 'AppData\\Local\\RemoteControlMCP\\backups\\startup'");
    expect(script).not.toContain("RCMCP_OWNER_USER=$env:USERNAME");
    expect(script).not.toContain("[Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)");
    const configuredOwner = script.indexOf("if (Test-RcmcpOwnerCandidate $ConfiguredOwnerCandidate)");
    const interactiveOwner = script.indexOf("} elseif (Test-RcmcpOwnerCandidate $InteractiveOwnerCandidate)");
    expect(configuredOwner).toBeGreaterThan(-1);
    expect(interactiveOwner).toBeGreaterThan(configuredOwner);
    const currentOwner = script.indexOf("} elseif (Test-RcmcpOwnerCandidate $CurrentOwnerCandidate)");
    expect(currentOwner).toBeGreaterThan(interactiveOwner);
    expect(script.match(/#Requires -RunAsAdministrator/g)).toHaveLength(1);
  });

  it("updates agent env as UTF-8 without BOM through an atomic replace helper", () => {
    const installer = source(installTask);
    const helper = source(updateEnv);
    expect(installer).toContain(". (Join-Path $PSScriptRoot 'update-agent-env.ps1')");
    expect(installer).toContain("Update-RcmcpAgentEnv -EnvFile $EnvFile");
    expect(installer).not.toContain("-Encoding ascii");
    expect(helper).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(helper).toContain("[IO.File]::Replace($EnvTemp, $EnvFile, $EnvBackup, $true)");
    expect(helper).toContain("Set-Acl -LiteralPath $EnvTemp");
  });

  it.skipIf(process.platform !== "win32")("round-trips Unicode values through the isolated env updater", () => {
    const root = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[IO.Path]::GetTempPath()"], { encoding: "utf8", windowsHide: true }).trim();
    const file = path.join(root, `rcmcp-env-${process.pid}-${Date.now()}.env`);
    const helperEscaped = updateEnv.replace(/'/g, "''");
    const fileEscaped = file.replace(/'/g, "''");
    const command = [
      "$utf8=[System.Text.UTF8Encoding]::new($false)",
      `[IO.File]::WriteAllLines('${fileEscaped}',[string[]]@(("UNICODE=" + $env:RCMCP_TEST_UNICODE),'RCMCP_OWNER_USER=old','RCMCP_NODE_PATH=old'),$utf8)`,
      `. '${helperEscaped}'`,
      `Update-RcmcpAgentEnv -EnvFile '${fileEscaped}' -NodePath $env:RCMCP_TEST_NODE -OwnerUser $env:RCMCP_TEST_OWNER | Out-Null`,
      `$bytes=[IO.File]::ReadAllBytes('${fileEscaped}')`,
      "[Convert]::ToBase64String($bytes)",
      `Remove-Item -LiteralPath '${fileEscaped}' -Force`,
    ].join(";");
    const base64 = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        RCMCP_TEST_UNICODE: "Șță 😀",
        RCMCP_TEST_NODE: "C:\\Program Files\\Nodé\\node.exe",
        RCMCP_TEST_OWNER: "andréi",
      },
    }).trim();
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const text = bytes.toString("utf8");
    expect(text).toContain("UNICODE=Șță 😀");
    expect(text).toContain("RCMCP_OWNER_USER=andréi");
    expect(text).toContain("RCMCP_NODE_PATH=C:\\Program Files\\Nodé\\node.exe");
  });

  it("removes the SYSTEM retry task before restoring the user launcher on failed install", () => {
    const script = source(installTask);
    const failure = script.indexOf("if (-not $Listener)");
    const stop = script.indexOf("Stop-ScheduledTask -TaskName 'RemoteControlMCPAgent'", failure);
    const unregister = script.indexOf("Unregister-ScheduledTask -TaskName 'RemoteControlMCPAgent'", failure);
    const restore = script.indexOf("Move-Item -Force $UserHostBackup $UserHost", failure);
    expect(stop).toBeGreaterThan(failure);
    expect(unregister).toBeGreaterThan(stop);
    expect(restore).toBeGreaterThan(unregister);
  });

  it("keeps disabled legacy Startup launchers outside the Startup directory", () => {
    const script = source(installTask);
    expect(script).toContain("$BackupDir = Join-Path $OwnerProfile 'AppData\\Local\\RemoteControlMCP\\backups\\startup'");
    expect(script).toContain("$UserHostBackup = Join-Path $BackupDir 'remote-control-mcp-agent.cmd.disabled-system'");
    expect(script).toContain("$LegacyBackup = \"$UserHost.disabled-system\"");
    expect(script).toContain("Move-Item -Force $LegacyBackup $UserHostBackup");
    expect(script).not.toContain("$UserHostBackup = \"$UserHost.disabled-system\"");
  });

  it.skipIf(process.platform !== "win32")("parses both deployment scripts in Windows PowerShell", () => {
    for (const file of [startAgent, installTask, updateEnv]) {
      const escaped = file.replace(/'/g, "''");
      const command = `$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{Write-Error $_.Message};exit 1}`;
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true,
        stdio: "pipe",
      });
    }
  });
});
