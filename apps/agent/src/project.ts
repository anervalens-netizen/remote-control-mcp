import crossSpawn from "cross-spawn";
import { runtimeEnv } from "./runtime-env.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ProjectInput } from "../../../packages/protocol/src/project.ts";
import { nativeCommand, shellQuote } from "./shell-quote.ts";

export function projectPlan(input: ProjectInput, env?: Record<string, string>) {
  if (input.command && input.executable) throw new Error("Use command (shell) or executable (native argv), not both");
  const action = input.action ?? "check";
  const has = (file: string) => existsSync(path.join(input.path, file));
  const names = readdirSync(input.path);
  const detectedStacks = [
    ...(has("package.json") ? ["node"] : []),
    ...(has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("Pipfile") ? ["python"] : []),
    ...(has("go.mod") || has("go.work") ? ["go"] : []),
    ...(has("Cargo.toml") ? ["rust"] : []),
    ...(names.some(name => /\.(slnx?|(cs|fs|vb)proj)$/i.test(name)) ? ["dotnet"] : []),
    ...(has("Makefile") || has("makefile") || has("GNUmakefile") ? ["make"] : []),
  ];
  const stack = input.command || input.executable ? "custom" : input.stack && input.stack !== "auto" ? input.stack : detectedStacks[0];
  const base = { path: input.path, action, stack, detectedStacks, selection: input.command ? "command" : input.executable ? "executable" : input.stack && input.stack !== "auto" ? "explicit" : "detected" };
  if (input.executable) { const argv = [input.executable, ...(input.args ?? [])]; return { ...base, manager: null, script: null, command: nativeCommand(argv), argv, availableScripts: [] as string[], availableActions: [] as string[] }; }
  if (input.command) return { ...base, manager: null, script: input.script ?? null,
    command: input.command + (input.args?.length ? " " + input.args.map(arg => shellQuote(arg)).join(" ") : ""),
    argv: null, availableScripts: [] as string[], availableActions: [] as string[] };
  if (!stack) throw new Error("No supported project manifest found. Set stack explicitly or supply command for any project.");
  let manager: string, argv: string[];
  let script: string | null = null, availableScripts: string[] = [], availableActions: string[] = [];
  if (stack === "node") {
    const pkg = JSON.parse(readFileSync(path.join(input.path, "package.json"), "utf8")) as { scripts?: Record<string, string>; packageManager?: string };
    const declared = pkg.packageManager?.replace(/@[^@]+$/, "");
    manager = input.manager ?? declared ?? (has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm");
    availableScripts = Object.keys(pkg.scripts ?? {}).sort(); availableActions = ["install", ...availableScripts];
    if (action === "install") argv = [manager, "install"];
    else {
      script = action === "script" ? input.script ?? "" : action;
      if (!script) throw new Error("script is required when action=script");
      if (!Object.hasOwn(pkg.scripts ?? {}, script)) {
        if (action === "check" && Object.hasOwn(pkg.scripts ?? {}, "test")) script = "test";
        else throw new Error(`Package script "${script}" not found. Available: ${availableScripts.join(", ")}. Supply command for a custom task.`);
      }
      argv = [manager, "run", script];
    }
  } else if (stack === "python") {
    manager = input.manager ?? (has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : has("Pipfile") ? "pipenv" : "pip");
    const localPython = path.join(input.path, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const python = existsSync(localPython) ? path.resolve(localPython) : process.platform === "win32" ? "python" : "python3";
    const prefix = manager === "uv" || manager === "poetry" || manager === "pipenv" ? [manager, "run", "python"] : manager === "pip" ? [python] : [manager];
    const tasks: Record<string, string[]> = {
      install: manager === "uv" ? ["uv", "sync"] : manager === "poetry" ? ["poetry", "install"] : manager === "pipenv" ? ["pipenv", "install"] : [...prefix, "-m", "pip", "install", ...(has("requirements.txt") ? ["-r", "requirements.txt"] : ["-e", "."])],
      check: [...prefix, "-m", "pytest"], test: [...prefix, "-m", "pytest"],
      build: manager === "uv" ? ["uv", "build"] : manager === "poetry" ? ["poetry", "build"] : [...prefix, "-m", "build"],
      typecheck: [...prefix, "-m", "mypy", "."], lint: [...prefix, "-m", "ruff", "check", "."],
    };
    availableActions = [...Object.keys(tasks), "script"];
    script = action === "script" ? input.script ?? null : null;
    if (action === "script" && !script) throw new Error("script is required: supply a Python file or use command for a module invocation");
    argv = action === "script" ? [...prefix, script!] : tasks[action]!;
  } else {
    const defaults = { go: "go", rust: "cargo", dotnet: "dotnet", make: "make" };
    manager = input.manager ?? defaults[stack as keyof typeof defaults];
    let goPackages = ["./..."];
    if (stack === "go" && has("go.work") && action !== "script" && action !== "install") {
      const parsed = crossSpawn.sync(manager, ["work", "edit", "-json", path.resolve(input.path, "go.work")], {
        cwd: input.path, env: runtimeEnv(env), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
      });
      if (parsed.error || parsed.status !== 0) throw new Error("Cannot inspect Go workspace: " + (parsed.error?.message ?? parsed.stderr));
      const work = JSON.parse(parsed.stdout) as { Use?: Array<{ DiskPath: string }> };
      goPackages = (work.Use ?? []).map(module => path.resolve(input.path, module.DiskPath).replaceAll("\\\\", "/") + "/...");
      if (!goPackages.length) throw new Error("Go workspace has no modules; add a use directive or supply command/executable");
    }
    const tasks: Record<string, Record<string, string[]>> = {
      go: { install: ["mod", "download"], check: ["vet", ...goPackages], test: ["test", ...goPackages], build: ["build", ...goPackages], typecheck: ["test", "-run", "^$", ...goPackages], lint: ["vet", ...goPackages] },
      rust: { install: ["fetch"], check: ["check"], test: ["test"], build: ["build"], typecheck: ["check"], lint: ["clippy"] },
      dotnet: { install: ["restore"], check: ["build"], test: ["test"], build: ["build"], typecheck: ["build"], lint: ["format", "--verify-no-changes"] },
    };
    if (stack === "make") {
      script = action === "script" ? input.script ?? null : action;
      if (!script) throw new Error("script is required when action=script");
      argv = [manager, "--", script]; availableActions = ["install", "check", "test", "build", "typecheck", "lint", "script"];
    } else {
      availableActions = [...Object.keys(tasks[stack]!), "script"];
      script = action === "script" ? input.script ?? null : null;
      if (action === "script" && !script) throw new Error("script is required: supply a native subcommand; extra arguments belong in args");
      argv = [manager, ...(action === "script" ? [script!] : tasks[stack]![action]!)];
    }
  }
  if (stack === "node" && manager === "npm" && script && input.args?.length) argv.push("--");
  argv.push(...(input.args ?? []));
  return { ...base, manager, script, command: nativeCommand(argv), argv, availableScripts, availableActions };
}
