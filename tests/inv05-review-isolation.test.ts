import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "linux")("qualifies INV-05 review source-probe confinement with synthetic fixtures", () => {
  const cwd = path.resolve(import.meta.dirname, "..");
  const result = spawnSync("/usr/bin/python3", ["tests/python/inv05_review_sandbox_test.py"], {
    cwd, encoding: "utf8", timeout: 45_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("Ran 10 tests");
  expect(result.stderr).toContain("OK");
  console.info(result.stderr.split("\n").filter(line => /Ran 10 tests|OK|skipped=/.test(line)).join(" | "));
}, 50_000);
