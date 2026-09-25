import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Native Windows fixtures cold-start PowerShell, compile .NET helpers and
    // load native assemblies; hosted-runner startup can exceed 15 seconds.
    // This is only the whole-test harness budget. Product command deadlines,
    // explicit timeout/heartbeat assertions and per-test budgets are unchanged.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
