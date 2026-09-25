import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { deployRunner } from "../apps/agent/src/deploy.ts";

function harness(failure: "transient" | "permanent" | "write" | "fsync", platform = "win32") {
  let now = 0, attempts = 0, closes = 0, writes = 0;
  let staged = false, installed = "OLD", payload = "";
  const denied = () => Object.assign(new Error("denied activation"), { code: "EPERM" });
  class Clock extends Date { static override now() { return now; } }
  const fs = {
    openSync: () => { staged = true; return 42; },
    writeFileSync: (_fd: number, text: string) => { writes++; if (failure === "write") throw new Error("write failed"); payload = text; },
    fsyncSync: () => { if (failure === "fsync") throw new Error("fsync failed"); },
    closeSync: () => { closes++; },
    renameSync: () => { attempts++; if (failure === "permanent" || failure === "transient" && attempts <= 3) throw denied(); installed = payload; staged = false; },
    rmSync: () => { staged = false; },
  };
  const source = deployRunner.slice(0, deployRunner.indexOf("async function phase(")) + "\npersist();";
  const invoke = () => runInNewContext(source, {
    require: (name: string) => name === "node:fs" ? fs : name === "node:path" ? path : {},
    process: { pid: 123, platform, env: { RCMCP_DEPLOY_INPUT: "{}", RCMCP_JOB_PROGRESS_FILE: "/state/progress" } },
    Date: Clock, Atomics: { wait: (_a: unknown, _i: unknown, _e: unknown, delay: number) => { now += delay; } },
  });
  return { invoke, state: () => ({ now, attempts, closes, writes, staged, installed }) };
}

it("retries only transient Windows atomic activation without rewriting progress or replaying a phase", () => {
  const h = harness("transient"); h.invoke();
  expect(h.state()).toMatchObject({ attempts: 4, writes: 1, closes: 1, staged: false, now: 30 });
  expect(JSON.parse(h.state().installed)).toMatchObject({ kind: "deploy", state: "running" });
});
it("bounds permanent Windows activation failure and retains old progress with no staging file", () => {
  const h = harness("permanent"); expect(h.invoke).toThrow("denied activation");
  expect(h.state()).toMatchObject({ now: 1000, staged: false, installed: "OLD", closes: 1, writes: 1 });
});
it.each(["write", "fsync"] as const)("cleans up on %s failure without replacing the previous journal", failure => {
  const h = harness(failure); expect(h.invoke).toThrow(`${failure} failed`);
  expect(h.state()).toMatchObject({ staged: false, installed: "OLD", closes: 1, attempts: 0 });
});
it("does not retry unrelated POSIX activation failure", () => {
  const h = harness("permanent", "linux"); expect(h.invoke).toThrow("denied activation");
  expect(h.state()).toMatchObject({ now: 0, attempts: 1, staged: false, installed: "OLD" });
});
