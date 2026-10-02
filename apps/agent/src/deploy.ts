import type { DeployInput } from "../../../packages/protocol/src/project.ts";
import { jobStart, immutableStateFile } from "./jobs.ts";
import { repoSnapshot, type RepoSnapshotFull } from "./repo.ts";
import { nativeCommand } from "./shell-quote.ts";
import { resolveHighLevelKey } from "./high-level-idempotency.ts";

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

type DeployBefore = RepoSnapshotFull | null;
type StoredDeployRun = { before: DeployBefore; jobCommand: string };
function parseStoredDeployRun(value: unknown): StoredDeployRun {
  if (!value || typeof value !== "object" || typeof (value as any).jobCommand !== "string") throw new Error("Invalid stored deployment execution");
  const before = (value as any).before;
  if (before !== null && (typeof before !== "object" || Array.isArray(before))) throw new Error("Invalid stored deployment snapshot");
  return { before: before as DeployBefore, jobCommand: (value as any).jobCommand };
}

export async function deployRun(input: DeployInput) {
  if (input.apply && input.command) throw new Error("Use apply or command for the deployment step, not both");
  const apply = input.apply ?? input.command;
  if (!apply) throw new Error("apply (or command) is required");
  const phases = { ...(input.prepare ? { prepare: input.prepare } : {}), apply,
    ...(input.verify ? { verify: input.verify } : {}), ...(input.recover ? { recover: input.recover } : {}) };
  const phased = Boolean(input.prepare || input.apply || input.verify || input.recover);
  const cwd = input.cwd ?? (phased ? input.repoPath : undefined);
  const plan = { phases, cwd: cwd ?? null, recoveryOnFailure: Boolean(input.recover) };
  if (input.dryRun) {
    const before = input.repoPath ? await repoSnapshot(input.repoPath, 3) : null;
    return { started: false, dryRun: true, plan, before };
  }
  let before: DeployBefore;
  let jobCommand: string;
  if (input.idempotencyKey) {
    const resolved = await resolveHighLevelKey<StoredDeployRun>({
      kind: "deploy_run", idempotencyKey: input.idempotencyKey,
      intent: { phases, cwd: cwd ?? null, repoPath: input.repoPath ?? null, env: input.env ?? {} },
      create: async () => {
        const originalBefore = input.repoPath ? await repoSnapshot(input.repoPath, 3) : null;
        const runner = immutableStateFile("deploy-runner", "cjs", deployRunner, 0o600);
        return { before: originalBefore, jobCommand: nativeCommand([process.execPath, runner]) };
      },
      parseValue: parseStoredDeployRun,
    });
    before = resolved.value.before;
    jobCommand = resolved.value.jobCommand;
  } else {
    before = input.repoPath ? await repoSnapshot(input.repoPath, 3) : null;
    const runner = immutableStateFile("deploy-runner", "cjs", deployRunner, 0o600);
    jobCommand = nativeCommand([process.execPath, runner]);
  }
  const job = await jobStart({ command: jobCommand, ...(cwd ? { cwd } : {}),
    env: { ...input.env, RCMCP_DEPLOY_INPUT: JSON.stringify(phases) }, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) });
  return { started: true, plan, before, job };
}
