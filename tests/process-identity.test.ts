import process from "node:process";
import { describe, expect, it } from "vitest";
import { currentProcessIdentity, matchesStoredProcessIdentity } from "../apps/agent/src/process-identity.ts";

describe("process identity", () => {
  it("matches the current process exactly", () => {
    const identity = currentProcessIdentity(process.pid);
    expect(identity).toBeTruthy();
    expect(matchesStoredProcessIdentity(process.pid, identity ?? undefined, new Date().toISOString())).toBe(true);
  });

  it.skipIf(process.platform === "win32")("binds Linux identities to the current boot and safely supports same-boot legacy ticks", () => {
    const identity = currentProcessIdentity(process.pid);
    expect(identity).toMatch(/^linux:[^:]+:\d+$/);
    const parts = identity!.split(":");
    const ticks = parts.at(-1)!;
    expect(matchesStoredProcessIdentity(process.pid, "linux:" + ticks, new Date().toISOString())).toBe(true);
    expect(matchesStoredProcessIdentity(process.pid, "linux:" + ticks, "2000-01-01T00:00:00.000Z")).toBe(false);
    expect(matchesStoredProcessIdentity(process.pid, "linux:wrong-boot:" + ticks, new Date().toISOString())).toBe(false);
  });
});
