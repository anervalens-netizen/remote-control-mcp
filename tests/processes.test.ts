import process from "node:process";
import { describe, expect, it } from "vitest";
import { killProcess, listProcesses, startProcess } from "../apps/agent/src/processes.ts";

async function waitForProcess(pid: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await listProcesses() as Array<{ pid?: number; ProcessId?: number }>;
    if (items.some((item) => item.pid === pid || item.ProcessId === pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Process ${pid} not found`);
}

describe("detached process control", () => {
  it("starts, lists and terminates a background process", async () => {
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const started = await startProcess({ command });
    expect(started.pid).toBeTypeOf("number");
    await waitForProcess(started.pid!);
    const killed = killProcess(started.pid!);
    expect(killed.ok).toBe(true);
  });

  it("treats an already-exited PID as an idempotent success", () => {
    const result = killProcess(2147483647);
    expect(result).toMatchObject({ ok: true, alreadyExited: true });
  });

  it("rejects a missing cwd without an unhandled child-process error", async () => {
    await expect(startProcess({ command: "echo never", cwd: "/definitely/missing/rcmcp-process-cwd" })).rejects.toThrow();
    const command = process.platform === "win32" ? "Start-Sleep -Milliseconds 200" : "sleep 0.2";
    const next = await startProcess({ command });
    expect(next.pid).toBeTypeOf("number");
  });

});
