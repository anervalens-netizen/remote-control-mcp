import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];
const previousStateRoot = process.env.RCMCP_STATE_DIR;

afterEach(async () => {
  vi.resetModules();
  if (previousStateRoot === undefined) delete process.env.RCMCP_STATE_DIR;
  else process.env.RCMCP_STATE_DIR = previousStateRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolatedRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-runner-recovery-"));
  roots.push(root);
  await mkdir(path.join(root, "jobs"), { recursive: true });
  process.env.RCMCP_STATE_DIR = root;
  return root;
}

async function waitDone(mod: typeof import("../apps/agent/src/jobs.ts"), id: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await mod.jobStatusAsync(id);
    if (status.state !== "running" && status.state !== "cancelling") return status;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("job did not finish");
}

describe("durable job runner upgrade compatibility", () => {
  it("never overwrites legacy shared runner files and reuses immutable content-addressed runners", async () => {
    const root = await isolatedRoot();
    const jobs = path.join(root, "jobs");
    const legacySh = path.join(jobs, "_runner.sh");
    const legacyPs1 = path.join(jobs, "_runner.ps1");
    await writeFile(legacySh, "LEGACY-SH\n");
    await writeFile(legacyPs1, "LEGACY-PS1\n");

    const first = await import("../apps/agent/src/jobs.ts");
    expect(first.jobList()).toEqual([]);
    expect(await readFile(legacySh, "utf8")).toBe("LEGACY-SH\n");
    expect(await readFile(legacyPs1, "utf8")).toBe("LEGACY-PS1\n");

    const immutable = (await readdir(jobs))
      .filter((name) => /^_(runner-(linux|windows)|helper-exit-marker)-[0-9a-f]{16}\.(sh|ps1|mjs)$/.test(name))
      .sort();
    expect(immutable).toHaveLength(3);
    const helper = immutable.find((name) => name.startsWith("_helper-exit-marker-"));
    expect(helper).toBeTruthy();
    const helperContent = await readFile(path.join(jobs, helper!), "utf8");
    expect(helperContent).toContain("fsyncSync(directory)");
    expect(helperContent).toContain("fsyncSync(log)");
    expect(helperContent.indexOf("fsyncSync(log)")).toBeLessThan(helperContent.indexOf("writeFileSync(temporary"));
    expect(await readFile(path.resolve("apps/agent/src/jobs.ts"), "utf8")).not.toContain('new URL("./job-exit-marker.ts"');
    const runnerContents = await Promise.all(
      immutable.filter((name) => name.startsWith("_runner-")).map((name) => readFile(path.join(jobs, name), "utf8")),
    );
    expect(runnerContents.every((content) => content.includes("RCMCP_JOB_EXIT_HELPER"))).toBe(true);
    const windowsRunner = runnerContents.find((content) => content.includes("$wrapped ="));
    expect(windowsRunner).toBeTruthy();
    expect(windowsRunner).toContain("$helperOutput = & $env:RCMCP_JOB_NODE");
    expect(windowsRunner).toContain("2>&1");
    expect(windowsRunner).not.toContain("2>> $env:RCMCP_JOB_STDERR");
    const before = await Promise.all(immutable.map(async (name) => ({
      name,
      content: await readFile(path.join(jobs, name), "utf8"),
      mtimeMs: (await stat(path.join(jobs, name))).mtimeMs,
    })));

    vi.resetModules();
    const second = await import("../apps/agent/src/jobs.ts");
    expect(second.jobList()).toEqual([]);
    expect(await readFile(legacySh, "utf8")).toBe("LEGACY-SH\n");
    expect(await readFile(legacyPs1, "utf8")).toBe("LEGACY-PS1\n");
    for (const item of before) {
      expect(await readFile(path.join(jobs, item.name), "utf8")).toBe(item.content);
      expect((await stat(path.join(jobs, item.name))).mtimeMs).toBe(item.mtimeMs);
    }
  });

  it("repairs a corrupt content-addressed helper before reuse", async () => {
    const root = await isolatedRoot();
    const jobs = path.join(root, "jobs");
    const first = await import("../apps/agent/src/jobs.ts");
    expect(first.jobList()).toEqual([]);
    const helper = (await readdir(jobs)).find((name) => name.startsWith("_helper-exit-marker-"));
    if (!helper) throw new Error("missing exit helper");
    const helperPath = path.join(jobs, helper);
    const expected = await readFile(helperPath, "utf8");
    await writeFile(helperPath, expected.slice(0, Math.max(1, Math.floor(expected.length / 3))));

    vi.resetModules();
    const second = await import("../apps/agent/src/jobs.ts");
    expect(second.jobList()).toEqual([]);
    expect(await readFile(helperPath, "utf8")).toBe(expected);
    expect((await readdir(jobs)).filter((name) => name.includes(".corrupt-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("never publishes completed when the durable exit helper fails", async () => {
    const root = await isolatedRoot();
    const jobs = path.join(root, "jobs");
    const mod = await import("../apps/agent/src/jobs.ts");
    const started = await mod.jobStart({ command: "echo BEFORE; sleep 0.5; echo AFTER" });
    const helper = (await readdir(jobs)).find((name) => name.startsWith("_helper-exit-marker-"));
    if (!helper) throw new Error("missing exit helper");
    await rename(path.join(jobs, helper), path.join(jobs, helper + ".missing"));

    const done = await waitDone(mod, started.id, 4000);
    expect(done).toMatchObject({ state: "lost", recoveryReason: "runner_exited_without_durable_marker" });
    expect(mod.jobOutput({ id: started.id, stream: "stdout", offset: 0, length: 4096 }).data).toContain("AFTER");
    await mod.jobRemove(started.id);
  });

  it("lets a running job finish across an agent module restart without runner mutation", async () => {
    const root = await isolatedRoot();
    const ready = path.join(root, "command-ready"), release = path.join(root, "command-release");
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const first = await import("../apps/agent/src/jobs.ts");
    const command = process.platform === "win32"
      ? `Write-Output BEFORE; [IO.File]::WriteAllText(${quote(ready + ".tmp")},"ready"); [IO.File]::Move(${quote(ready + ".tmp")},${quote(ready)}); while(-not(Test-Path -LiteralPath ${quote(release)})){Start-Sleep -Milliseconds 20}; Write-Output AFTER`
      : `echo BEFORE; printf ready > ${quote(ready + ".tmp")}; mv ${quote(ready + ".tmp")} ${quote(ready)}; while [ ! -f ${quote(release)} ]; do sleep 0.02; done; echo AFTER`;
    const started = await first.jobStart({ command });
    let second = first;
    try {
      // A spawned runner is not proof that its command started. Hold the real
      // command across reload, rather than measuring cold PowerShell startup
      // against the unrelated three-second post-release completion budget.
      const readyDeadline = Date.now() + 5000;
      let readyText = "";
      while (Date.now() < readyDeadline) {
        try { readyText = await readFile(ready, "utf8"); if (readyText === "ready") break; }
        catch (error) { if (!["ENOENT", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(readyText).toBe("ready");
      expect((await first.jobStatusAsync(started.id)).state).toBe("running");
      vi.resetModules();
      second = await import("../apps/agent/src/jobs.ts");
      expect((await second.jobStatusAsync(started.id)).state).toBe("running");
      await writeFile(release, "release");
      const done = await waitDone(second, started.id);
      expect(done).toMatchObject({ state: "completed", exitCode: 0 });
      expect(second.jobOutput({ id: started.id, stream: "stdout", offset: 0, length: 4096 }).data).toContain("AFTER");
      await second.jobRemove(started.id);
    } finally {
      await writeFile(release, "release");
      try {
        const status = await second.jobStatusAsync(started.id);
        if (status.state === "running" || status.state === "cancelling") {
          try { await waitDone(second, started.id); } catch { await second.jobCancel(started.id); }
        }
        await second.jobRemove(started.id);
      } catch (error) {
        // The successful path already removed its job. Otherwise preserve the
        // release file/evidence instead of deleting state under a live runner.
        if (await stat(path.join(root, "jobs", started.id + ".json")).catch(() => undefined)) {
          const index=roots.indexOf(root); if(index>=0)roots.splice(index,1);
          console.error(`Recovery fixture cleanup evidence retained at ${root}: ${String(error)}`);
        }
      }
    }
  });
});
