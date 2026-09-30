import { expect, it } from "vitest";
import { windowsNativePath, windowsRobocopyPath } from "../apps/agent/src/windows-native-path.ts";

it("keeps native extended file paths but gives robocopy equivalent DOS and UNC arguments", () => {
  const dos = String.raw`C:\fixture\folder\file.bin`;
  const unc = String.raw`\\fixture-host\share\folder\file.bin`;
  expect(windowsNativePath(dos)).toBe(String.raw`\\?\C:\fixture\folder\file.bin`);
  expect(windowsRobocopyPath(dos)).toBe(dos);
  expect(windowsRobocopyPath(windowsNativePath(dos))).toBe(dos);
  expect(windowsRobocopyPath(unc)).toBe(unc);
  expect(windowsRobocopyPath(windowsNativePath(unc))).toBe(unc);
});
it("does not truncate long paths or reinterpret other native namespaces", () => {
  const long = "C:\\fixture\\" + "x".repeat(220) + "\\" + "y".repeat(120);
  expect(windowsRobocopyPath(windowsNativePath(long))).toBe(long);
  const device = String.raw`\\.\fixture-device`;
  expect(windowsRobocopyPath(device)).toBe(windowsNativePath(device));
});
