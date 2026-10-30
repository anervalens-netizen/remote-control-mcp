import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const source = path.resolve("deploy/windows/updater/run-update.ps1");
const fixture = path.resolve("tests/fixtures/windows-updater-sim.ps1");
function run(scenario: string) {
  const result = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
    "-Source", source, "-Node", process.execPath, "-Scenario", scenario], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return JSON.parse(result);
}
describe.skipIf(process.platform !== "win32")("guarded Windows updater with isolated simulated adapters", () => {
  it("handles orphaned agents and preserves recovery receipts without replay", () => {
    const r=run("success"); expect(r.phase).toBe("candidate_verified"); expect(r.kills).toEqual([1001,1002]);
    expect(r.guardRetained).toBe(false); expect(r.events).toContain("before_task_disable"); expect(r.events).toContain("before_old_process_stop"); expect(r.lost).toBe(1);
    expect(r.inspectionPhase).toBe(r.phase); expect(r.inspectionUnchanged).toBe(true); expect(r.replayRefused).toBe(true);
  });
  it("restores task actions and verifies old listeners after candidate health fails", () => {
    const r=run("rollback"); expect(r.phase).toBe("rollback_health_verified"); expect(r.kills).toEqual([1001,1002,2001,2002]);
    expect(r.guardRetained).toBe(false); expect(r.tasks.map((t: {args:string})=>t.args)).toEqual(["old-1","old-2"]);
    expect(r.events).toContain("before_candidate_process_stop"); expect(r.replayRefused).toBe(true);
  });
  it("waits for the candidate wrapper before starting the old task", () => {
    const r=run("delayed"); expect(r.phase).toBe("rollback_health_verified"); expect(r.kills).toEqual([1001,1002,2001,2002]);
  });
  it("retains the guard when the candidate wrapper never exits", () => {
    const r=run("stuck"); expect(r.phase).toBe("rollback_incomplete"); expect(r.guardRetained).toBe(true);
    expect(r.guardRefused).toBe(true); expect(r.events).not.toContain("before_old_task_start");
  });
  it("fails before any effect when an active job is observed", () => {
    const r=run("active"); expect(r.phase).toBe("failed_before_effect"); expect(r.kills ?? []).toEqual([]);
    expect(r.guardRetained).toBe(false); expect(r.events).not.toContain("before_task_action"); expect(r.replayRefused).toBe(true);
  });
  it("refuses an unexpected port owner rather than killing it", () => {
    const r=run("conflict"); expect(r.phase).toBe("rollback_incomplete"); expect(r.kills).toEqual([1001,1002]);
    expect(r.guardRetained).toBe(true); expect(r.guardRefused).toBe(true); expect(r.noAdditionalKills).toBe(true); expect(r.kills).not.toContain(9999); expect(r.replayRefused).toBe(true);
  });
});


describe.skipIf(process.platform !== "win32")("native Windows updater primitives", () => {
  it("binds a kernel handle to the intended process and restores empty task paths", () => {
    const native = path.resolve("tests/fixtures/windows-updater-native.ps1");
    const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", native, "-Source", source],
      { encoding: "utf8", windowsHide: true, timeout: 30000 });
    expect(JSON.parse(output)).toEqual({ wrongRejected: true, targetAlive: true, targetStopped: true, controlAlive: true, nullOmitted: true, explicitKept: true });
  });
});
