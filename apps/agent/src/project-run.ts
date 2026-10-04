import { executionBoundary } from "./execution-boundary.ts";
import { createRequire } from "node:module";
import type { ProjectRunInput } from "../../../packages/protocol/src/project.ts";
import { projectPlan } from "./project.ts";
import { runCommand, runProcess } from "./exec.ts";
import { immutableStateFile, jobStart } from "./jobs.ts";
import { resolveHighLevelKey } from "./high-level-idempotency.ts";
import { nativeCommand } from "./shell-quote.ts";

const crossSpawnPath = createRequire(import.meta.url).resolve("cross-spawn");
type ProjectPlan = ReturnType<typeof projectPlan>;
type StoredProjectRun = { plan: ProjectPlan; jobCommand: string };

function parseStoredPlan(value: unknown): ProjectPlan {
  if (!value || typeof value !== "object" || typeof (value as any).command !== "string" || !("argv" in (value as any))) throw new Error("Invalid stored project plan");
  return value as ProjectPlan;
}

function parseStoredProjectRun(value: unknown): StoredProjectRun {
  if (!value || typeof value !== "object" || typeof (value as any).jobCommand !== "string") throw new Error("Invalid stored project execution");
  return { plan: parseStoredPlan((value as any).plan), jobCommand: (value as any).jobCommand };
}

function projectJobCommand(plan: ProjectPlan): string {
  if (!plan.argv) return plan.command;
  const runner = immutableStateFile("project-runner", "cjs",
    "const spawn = require(" + JSON.stringify(crossSpawnPath) + ");\n" +
    "const argv = JSON.parse(process.env.RCMCP_PROJECT_ARGV);\n" +
    "const result = spawn.sync(argv[0], argv.slice(1), {stdio:'inherit',windowsHide:true});\n" +
    "if(result.error)process.stderr.write(String(result.error.stack || result.error)+'\\n');\n" +
    "process.exitCode = result.status == null ? 1 : result.status;\n", 0o600);
  return nativeCommand([process.execPath, runner]);
}

export async function projectRun(input: ProjectRunInput, signal?: AbortSignal) {
  return executionBoundary(async submit => {
    const mode = input.mode ?? "job";
    if (mode === "exec" && input.idempotencyKey) throw new Error("idempotencyKey is supported only for durable project_run mode=job");
    if (input.dryRun) return { plan: projectPlan(input, input.env), mode, dryRun: true };

    let plan: ProjectPlan;
    let storedCommand: string | undefined;
    if (mode === "job" && input.idempotencyKey) {
      const resolved = await resolveHighLevelKey<StoredProjectRun>({
        kind: "project_run",
        idempotencyKey: input.idempotencyKey,
        intent: {
          path: input.path,
          action: input.action ?? "check",
          stack: input.stack ?? "auto",
          manager: input.manager ?? null,
          script: input.script ?? null,
          command: input.command ?? null,
          executable: input.executable ?? null,
          args: input.args ?? [],
          env: input.env ?? {},
        },
        create: () => {
          const derived = projectPlan(input, input.env);
          return { plan: derived, jobCommand: projectJobCommand(derived) };
        },
        parseValue: parseStoredProjectRun,
      });
      plan = resolved.value.plan;
      storedCommand = resolved.value.jobCommand;
    } else {
      plan = projectPlan(input, input.env);
    }

    if (mode === "exec") {
      const options = { cwd: input.path, env: input.env, timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes };
      submit();
      const result = plan.argv
        ? await runProcess(plan.argv[0]!, plan.argv.slice(1), { ...options, portable: true, signal })
        : await runCommand({ command: plan.command, ...options }, signal);
      return { plan, mode, result, ok: result.code === 0 && !result.timedOut && !result.cancelled && !result.cancellationRequested };
    }

    const command = storedCommand ?? projectJobCommand(plan);
    const env = plan.argv ? { ...input.env, RCMCP_PROJECT_ARGV: JSON.stringify(plan.argv) } : input.env;
    submit();
    const result = await jobStart({
      command,
      cwd: input.path,
      ...(env ? { env } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return { plan, mode, result };
  });
}
