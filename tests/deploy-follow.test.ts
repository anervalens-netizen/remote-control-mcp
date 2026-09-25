import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deployRun } from "../apps/agent/src/deploy.ts";
import { jobFollow } from "../apps/agent/src/job-follow.ts";
import { jobStart, jobStatus, jobCancel, jobRemove } from "../apps/agent/src/jobs.ts";
import { nativeCommand, shellQuote } from "../apps/agent/src/shell-quote.ts";
const roots: string[] = [], jobs: string[] = [];
afterEach(async () => {
  for (const id of jobs.splice(0)) { await jobCancel(id); await jobRemove(id); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-deploy-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}
async function start(script: string) {
  const root = await fixture({ "run.cjs": script });
  const job = await jobStart({ cwd: root, command: nativeCommand([process.execPath, path.join(root, "run.cjs")]) });
  jobs.push(job.id); return job;
}
describe("deployment phases", () => {
  it.each([null, "prepare", "apply", "verify"] as const)("journals phases and recovers failure at %s without false success", async failed => {
    const root = await fixture({ "phase.cjs": 'const fs=require("node:fs"); const name=process.argv[2]; fs.appendFileSync("phases.txt",name+"\\n"); process.exitCode = name === process.env.FAIL_PHASE ? 23 : 0;' });
    const command = (phase: string) => nativeCommand([process.execPath, path.join(root, "phase.cjs"), phase]);
    const run = await deployRun({ cwd: root, prepare: command("prepare"), apply: command("apply"), verify: command("verify"), recover: command("recover"), env: { FAIL_PHASE: failed ?? "" } });
    jobs.push(run.job!.id);
    const done = await jobFollow({ id: run.job!.id, waitMs: 20000 });
    expect(done, JSON.stringify(done)).toMatchObject({ terminal: true, exitCode: failed ? 23 : 0, progress: { state: failed ? "recovered" : "succeeded" } });
    const expected = failed ? ["prepare", "apply", "verify"].slice(0, ["prepare", "apply", "verify"].indexOf(failed) + 1).concat("recover") : ["prepare", "apply", "verify"];
    expect((await readFile(path.join(root, "phases.txt"), "utf8")).trim().split("\n")).toEqual(expected);
    vi.resetModules();
    const recovered = await import("../apps/agent/src/jobs.ts");
    expect(recovered.jobStatus(run.job!.id)).toMatchObject({ exitCode: failed ? 23 : 0, progress: { state: failed ? "recovered" : "succeeded" } });
  }, 25000);
  it("marks interrupted progress after cancellation without replaying recovery", async () => {
    const root = await fixture({ "wait.cjs": 'process.stdout.write("READY"); setTimeout(()=>{},30000);', "recover.cjs": 'require("node:fs").writeFileSync("recovered.txt","unexpected");' });
    const run = await deployRun({ cwd: root, apply: nativeCommand([process.execPath, path.join(root, "wait.cjs")]), recover: nativeCommand([process.execPath, path.join(root, "recover.cjs")]) });
    jobs.push(run.job!.id);
    let page = await jobFollow({ id: run.job!.id, until: "output", waitMs: 10000 });
    for (let i = 0; i < 20 && !page.stdout.data.includes("READY"); i++) page = await jobFollow({ id: run.job!.id, cursor: page.cursor, until: "output", waitMs: 500 });
    expect(page.stdout.data).toContain("READY");
    await jobCancel(run.job!.id);
    expect(jobStatus(run.job!.id)).toMatchObject({ state: process.platform === "win32" ? "lost" : "cancelled", progressInterrupted: true });
    if (process.platform === "win32") expect(jobStatus(run.job!.id).terminationVerified).toBe(false);
    await expect(readFile(path.join(root, "recovered.txt"))).rejects.toThrow();
  }, 20000);
  it.runIf(process.platform === "win32")("preserves an ordinary native phase exit without caller exit boilerplate", async () => {
    const root = await fixture({ "fail.cjs": 'process.exitCode=23;' });
    const apply = "& " + [process.execPath, path.join(root, "fail.cjs")].map(value => shellQuote(value)).join(" ");
    const run = await deployRun({ cwd: root, apply, recover: "Write-Output RECOVERED" }); jobs.push(run.job!.id);
    const done = await jobFollow({ id: run.job!.id, waitMs: 15000 });
    expect(done, JSON.stringify(done)).toMatchObject({ exitCode: 23, progress: { state: "recovered", exitCode: 23 } });
  }, 20000);
  it.runIf(process.platform === "win32")("ignores stale native LASTEXITCODE after a later successful PowerShell command", async () => {
    const root = await fixture({ "fail.cjs": 'process.exitCode=23;' });
    const native = "& " + [process.execPath, path.join(root, "fail.cjs")].map(value => shellQuote(value)).join(" ");
    const run = await deployRun({ cwd: root, apply: native + "; Write-Output FINAL_SUCCESS" });
    jobs.push(run.job!.id);
    const done = await jobFollow({ id: run.job!.id, waitMs: 15000 });
    expect(done, JSON.stringify(done)).toMatchObject({ exitCode: 0, progress: { state: "succeeded", exitCode: 0 } });
  }, 20000);
  it("keeps the original failure when recovery also fails and dry-run creates no job", async () => {
    expect(await deployRun({ apply: "exit 17", recover: "exit 19", dryRun: true })).toMatchObject({ started: false, dryRun: true });
    const run = await deployRun({ apply: "exit 17", recover: "exit 19" }); jobs.push(run.job!.id);
    const done = await jobFollow({ id: run.job!.id, waitMs: 15000 });
    expect(done, JSON.stringify(done)).toMatchObject({ exitCode: 17, progress: { state: "failed", recoverySucceeded: false, failedPhase: "apply" } });
  }, 20000);
});
describe("resumable job follow", () => {
  it("pages both UTF-8 streams without splitting codepoints even with a one-byte budget", async () => {
    const job = await start('process.stdout.write("A😀€Z"); process.stderr.write("é😀!");');
    let page = await jobFollow({ id: job.id, waitMs: 10000, maxBytes: 1 });
    let stdout = page.stdout.data, stderr = page.stderr.data, calls = 0;
    while (!page.outputComplete && calls++ < 20) {
      page = await jobFollow({ id: job.id, cursor: page.cursor, waitMs: 0, maxBytes: 1 });
      stdout += page.stdout.data; stderr += page.stderr.data;
    }
    expect(stdout).toBe("A😀€Z"); expect(stderr).toBe("é😀!"); expect(page.outputComplete).toBe(true);
  }, 15000);
  it("preserves binary bytes and finishes an incomplete final UTF-8 sequence", async () => {
    const job = await start('process.stdout.write(Buffer.from([0xf0,0x9f]));');
    const binary = await jobFollow({ id: job.id, waitMs: 10000, encoding: "base64", maxBytes: 1 });
    expect(Buffer.from(binary.stdout.data, "base64")).toEqual(Buffer.from([0xf0]));
    const text = await jobFollow({ id: job.id, waitMs: 0, maxBytes: 1 });
    expect(text.stdout.data).toBe("�"); expect(text.cursor.stdout).toBe(2); expect(text.outputComplete).toBe(true);
  }, 15000);
  it("waits for a complete UTF-8 codepoint instead of returning an empty output page", async () => {
    const job = await start('process.stdout.write(Buffer.from([0xf0])); setTimeout(()=>process.stdout.write(Buffer.from([0x9f,0x98,0x80])),2000); setTimeout(()=>{},15000);');
    const page = await jobFollow({ id: job.id, until: "output", waitMs: 10000, maxBytes: 1 });
    expect(page.stdout.data).toBe("😀"); expect(page.cursor.stdout).toBe(4); expect(page.terminal).toBe(false);
  }, 15000);
  it("returns fresh output before completion and aborts waiting without cancelling work", async () => {
    const job = await start('process.stdout.write("READY"); setTimeout(()=>process.stdout.write("END"), 15000);');
    const page = await jobFollow({ id: job.id, until: "output", waitMs: 10000 });
    expect(page).toMatchObject({ terminal: false, stdout: { data: "READY" } });
    const controller = new AbortController();
    const pending = jobFollow({ id: job.id, cursor: page.cursor, waitMs: 10000 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(jobStatus(job.id).state).toBe("running");
    const timed = await jobFollow({ id: job.id, cursor: page.cursor, waitMs: 1 });
    expect(timed).toMatchObject({ terminal: false, waitExpired: true });
  }, 20000);
});
