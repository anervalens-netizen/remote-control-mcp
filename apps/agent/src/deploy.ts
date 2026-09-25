import type { DeployInput } from "../../../packages/protocol/src/project.ts";
import { jobStart, immutableStateFile } from "./jobs.ts";
import { repoSnapshot } from "./repo.ts";
import { nativeCommand } from "./shell-quote.ts";

// An immutable, self-contained runner continues across agent upgrades/restarts.
export const deployRunner = String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const input = JSON.parse(process.env.RCMCP_DEPLOY_INPUT);
const progressPath = process.env.RCMCP_JOB_PROGRESS_FILE;
const state = { kind: "deploy", state: "running", phase: null, startedAt: new Date().toISOString(), phases: [] };
function persist() {
  const temporary = progressPath + ".tmp." + process.pid;
  let fd;
  try {
    fd = fs.openSync(temporary, "w", 0o600);
    fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    const deadline = Date.now() + 1000;
    while (true) {
      try { fs.renameSync(temporary, progressPath); break; }
      catch (error) {
        // A progress reader or scanner may briefly hold the Windows target.
        // Retry only denied/busy atomic activation, never a deployment phase.
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (process.platform !== "win32") { const directory = fs.openSync(path.dirname(progressPath), "r"); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}
async function phase(name, command) {
  state.phase = name;
  const item = { name, state: "running", startedAt: new Date().toISOString() };
  state.phases.push(item); persist();
  process.stderr.write("[deploy] " + name + " started\n");
  const windows = process.platform === "win32";
  const wrapped = "$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; $script:rcmcpPhaseSucceeded=$false; $script:rcmcpPhaseExitCode=0; try { & { " + command + "\n; $script:rcmcpPhaseSucceeded=$?; $script:rcmcpPhaseExitCode=$LASTEXITCODE }; if ($script:rcmcpPhaseSucceeded) { exit 0 }; if ($script:rcmcpPhaseExitCode -ne 0) { exit $script:rcmcpPhaseExitCode }; exit 1 } catch { [Console]::Error.WriteLine($_); exit 1 }";
  const file = windows ? "powershell.exe" : "/bin/bash";
  const args = windows ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(wrapped, "utf16le").toString("base64")] : ["-lc", command];
  const result = await new Promise(resolve => {
    const child = cp.spawn(file, args, { windowsHide: true, stdio: "inherit", env: process.env });
    child.once("error", error => resolve({ code: 1, error: error.message }));
    child.once("close", (code, signal) => resolve({ code: code == null ? 1 : code, signal }));
  });
  Object.assign(item, result, { state: result.code === 0 ? "succeeded" : "failed", finishedAt: new Date().toISOString() });
  persist();
  process.stderr.write("[deploy] " + name + " " + item.state + " (exit " + result.code + ")\n");
  return result.code;
}
(async () => {
  persist();
  let code = 0;
  for (const name of ["prepare", "apply", "verify"]) {
    if (!input[name]) continue;
    code = await phase(name, input[name]);
    if (code !== 0) {
      state.failedPhase = name;
      if (input.recover) {
        const recoveryCode = await phase("recover", input.recover);
        state.recoverySucceeded = recoveryCode === 0;
      }
      break;
    }
  }
  state.state = code === 0 ? "succeeded" : state.recoverySucceeded ? "recovered" : "failed";
  state.finishedAt = new Date().toISOString(); state.exitCode = code; persist();
  // Recovery never turns a failed deployment into a successful exit.
  process.exitCode = code;
})().catch(error => { process.stderr.write(String(error.stack || error) + "\n"); process.exitCode = 1; });
`;

export async function deployRun(input: DeployInput) {
  if (input.apply && input.command) throw new Error("Use apply or command for the deployment step, not both");
  const apply = input.apply ?? input.command;
  if (!apply) throw new Error("apply (or command) is required");
  const phases = { ...(input.prepare ? { prepare: input.prepare } : {}), apply,
    ...(input.verify ? { verify: input.verify } : {}), ...(input.recover ? { recover: input.recover } : {}) };
  const cwd = input.cwd ?? input.repoPath;
  const before = input.repoPath ? await repoSnapshot(input.repoPath, 3) : null;
  const plan = { phases, cwd: cwd ?? null, recoveryOnFailure: Boolean(input.recover) };
  if (input.dryRun) return { started: false, dryRun: true, plan, before };
  const runner = immutableStateFile("deploy-runner", "cjs", deployRunner, 0o600);
  const job = await jobStart({ command: nativeCommand([process.execPath, runner]), ...(cwd ? { cwd } : {}),
    env: { ...input.env, RCMCP_DEPLOY_INPUT: JSON.stringify(phases) } });
  return { started: true, plan, before, job };
}
