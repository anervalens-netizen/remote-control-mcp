import { spawnSync } from "node:child_process";
import { runProcess } from "../apps/agent/src/exec.ts";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectPlan } from "../apps/agent/src/project.ts";
import { projectRun } from "../apps/agent/src/project-run.ts";
import { jobFollow } from "../apps/agent/src/job-follow.ts";
import { jobCancel, jobRemove } from "../apps/agent/src/jobs.ts";
const roots: string[] = [], jobs: string[] = [];
afterEach(async () => {
  for (const id of jobs.splice(0)) { await jobCancel(id); await jobRemove(id); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-project-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
  return root;
}
const go = process.env.RCMCP_TEST_GO ?? "go";
const hasGo = spawnSync(go, ["version"], { windowsHide: true, timeout: 5000 }).status === 0;
describe("project runner", () => {
  it.skipIf(!hasGo)("checks, tests and builds every module from a real Go workspace root", async () => {
    const root = await fixture({
      "go.work": 'go 1.22\nuse (\n ./a\n "./b space"\n)\n',
      "a/go.mod": "module example/a\ngo 1.22\n", "a/a.go": "package a\nfunc Value() int { return 1 }\n",
      "b space/go.mod": "module example/b\ngo 1.22\n", "b space/b.go": "package b\nfunc Value() int { return 2 }\n",
    });
    const original = await runProcess(go, ["vet", "./..."], { cwd: root });
    expect(original.code).not.toBe(0);
    for (const action of ["check", "test", "build", "install"] as const) {
      const result = await projectRun({ path: root, action, mode: "exec", manager: go });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (action !== "install") expect(result.plan.argv?.filter(arg => arg.endsWith("/..."))).toHaveLength(2);
    }
  }, 120000);
  it.each([
    ["pyproject.toml", "python", "pytest"], ["go.mod", "go", "vet"],
    ["Cargo.toml", "rust", "check"], ["app.csproj", "dotnet", "build"], ["Makefile", "make", "check"],
  ])("detects %s and offers a runnable check", async (manifest, stack, argument) => {
    const root = await fixture({ [manifest]: "" });
    const plan = projectPlan({ path: root });
    expect(plan.stack).toBe(stack); expect(plan.argv).toContain(argument);
  });
  it("reports ambiguous stacks and honors explicit selection", async () => {
    const root = await fixture({ "package.json": '{"scripts":{"test":"node test.cjs"}}', "Cargo.toml": "" });
    expect(projectPlan({ path: root })).toMatchObject({ stack: "node", detectedStacks: ["node", "rust"], script: "test" });
    expect(projectPlan({ path: root, stack: "rust" })).toMatchObject({ stack: "rust", selection: "explicit", argv: ["cargo", "check"] });
  });
  it("does not execute a dry-run and rejects inherited package script names", async () => {
    const root = await fixture({ "package.json": '{"scripts":{}}' });
    const run = await projectRun({ path: root, command: "exit 73", dryRun: true });
    expect(run).toMatchObject({ dryRun: true, plan: { stack: "custom" } });
    expect(() => projectPlan({ path: root, action: "script", script: "toString" })).toThrow(/not found/);
  });
  it.each(["exec", "job"] as const)("preserves literal native argv, environment and exit status in %s", async mode => {
    const root = await fixture({ "pyproject.toml": "", "args.cjs": 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),value:process.env.PROJECT_TEST})); process.exitCode=17;' });
    const args = ["two words", "", 'double"quote', "semi;colon", "$literal", "😀", "a'b", "end\\"];
    const run = await projectRun({ path: root, executable: process.execPath, args: ["args.cjs", ...args], env: { PROJECT_TEST: "from-env" }, mode });
    let output: string;
    if (mode === "job") {
      const job = run.result as { id: string }; jobs.push(job.id);
      const done = await jobFollow({ id: job.id, waitMs: 15000 });
      expect(done).toMatchObject({ terminal: true, exitCode: 17 });
      output = done.stdout.data;
    } else {
      expect(run).toMatchObject({ ok: false, result: { code: 17, timedOut: false } });
      output = (run.result as { stdout: string }).stdout;
    }
    expect(JSON.parse(output)).toEqual({ args, value: "from-env" });
  }, 20000);
  it("executes an actual package script with npm argument forwarding", async () => {
    const root = await fixture({ "package.json": '{"scripts":{"check":"node args.cjs"}}', "args.cjs": 'require("node:fs").writeFileSync("result.json", JSON.stringify(process.argv.slice(2)));' });
    const args = ["two words", "", 'double"quote', "semi;colon", "$literal"];
    const run = await projectRun({ path: root, mode: "exec", args, timeoutMs: 15000 });
    expect(run).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(path.join(root, "result.json"), "utf8"))).toEqual(args);
  }, 20000);
});
