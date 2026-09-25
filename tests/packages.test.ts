import { describe, expect, it } from "vitest";
import { buildPackageCommand, packageOperationOk } from "../apps/agent/src/host.ts";

describe("package operation result semantics", () => {
  it("reports an explicit success flag from exit code and timeout state", () => {
    expect(packageOperationOk({ code: 0, timedOut: false })).toBe(true);
    expect(packageOperationOk({ code: 1, timedOut: false })).toBe(false);
    expect(packageOperationOk({ code: 0, timedOut: true })).toBe(false);
    expect(packageOperationOk({ code: null, timedOut: false })).toBe(false);
  });
});

describe("package target semantics", () => {
  it("never turns an omitted Chocolatey remove target into uninstall all", () => {
    expect(() => buildPackageCommand("choco", "remove", [], false)).toThrow(/all=true/);
    expect(buildPackageCommand("choco", "remove", [], true)).toEqual({ file: "choco", args: ["uninstall", "all", "-y"] });
    expect(buildPackageCommand("choco", "remove", ["git"], false)).toEqual({ file: "choco", args: ["uninstall", "git", "-y"] });
  });

  it("requires explicit all=true for global upgrades while keeping them available", () => {
    expect(() => buildPackageCommand("apt-get", "upgrade", [], false)).toThrow(/all=true/);
    expect(buildPackageCommand("apt-get", "upgrade", [], true).args).toEqual(["upgrade", "-y"]);
    expect(() => buildPackageCommand("winget", "upgrade", [], false)).toThrow(/all=true/);
    expect(buildPackageCommand("winget", "upgrade", [], true).args).toContain("--all");
  });
});
