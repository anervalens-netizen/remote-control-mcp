import { createRequire } from "node:module";
import type { ProjectRunInput } from "../../../packages/protocol/src/project.ts";
import { projectPlan } from "./project.ts";
import { runCommand, runProcess } from "./exec.ts";
import { immutableStateFile, jobStart } from "./jobs.ts";
import { nativeCommand } from "./shell-quote.ts";

const crossSpawnPath = createRequire(import.meta.url).resolve("cross-spawn");
export async function projectRun(input: ProjectRunInput, signal?: AbortSignal) {
  const plan = projectPlan(input, input.env), mode = input.mode ?? "job";
  if (input.dryRun) return { plan, mode, dryRun: true };
  if (mode === "exec") {
    const options = { cwd: input.path, env: input.env, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes };
    const result = plan.argv
      ? await runProcess(plan.argv[0]!, plan.argv.slice(1), { ...options, portable: true, signal })
      : await runCommand({ command: plan.command, ...options }, signal);
    return { plan, mode, result, ok: result.code === 0 && !result.timedOut && !result.cancelled && !result.cancellationRequested };
  }
  let command = plan.command, env = input.env;
  if (plan.argv) {
    const runner = immutableStateFile("project-runner", "cjs",
      "const spawn = require(" + JSON.stringify(crossSpawnPath) + ");\n" +
      "const argv = JSON.parse(process.env.RCMCP_PROJECT_ARGV);\n" +
      "const result = spawn.sync(argv[0], argv.slice(1), {stdio:'inherit',windowsHide:true});\n" +
      "if(result.error)process.stderr.write(String(result.error.stack || result.error)+'\\n');\n" +
      "process.exitCode = result.status == null ? 1 : result.status;\n", 0o600);
    command = nativeCommand([process.execPath, runner]);
    env = { ...env, RCMCP_PROJECT_ARGV: JSON.stringify(plan.argv) };
  }
  const result = await jobStart({ command, cwd: input.path, ...(env ? { env } : {}) });
  return { plan, mode, result };
}
