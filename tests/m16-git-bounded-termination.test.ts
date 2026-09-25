import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), identity: vi.fn(), terminate: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock("../apps/agent/src/process-identity.ts", () => ({ currentProcessIdentityAsync: mocks.identity, terminateVerifiedProcessTreeDetailedAsync: mocks.terminate }));
import { repoFetch } from "../apps/agent/src/repo.ts";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each(["unverified", "reject", "hang", "identity-missing"])("bounds Git timeout and reports uncertainty when Windows termination %s", async mode => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("RCMCP_RUNTIME_CONTEXT", "user"); vi.stubEnv("USERNAME", "test-owner");
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: 42424242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false) });
  mocks.spawn.mockReturnValue(child); mocks.identity.mockResolvedValue(mode === "identity-missing" ? null : "win:test-creation");
  mocks.terminate.mockImplementation(() => mode === "hang" ? new Promise(() => {}) : mode === "reject" ? Promise.reject(new Error("denied")) : Promise.resolve({ terminated: false, rootStopped: false }));
  mocks.execFile.mockImplementation((...args: unknown[]) => { (args.at(-1) as (e: Error) => void)(new Error("taskkill denied")); });
  let settled = false;
  const result = repoFetch({ path: process.cwd(), timeoutMs: 100 }).then(() => "unexpected-success", error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(settled).toBe(true); expect(await result).toHaveProperty("message", expect.stringMatching(/timed out.*termination unverified.*may still be running/));
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", 0, null); expect(mocks.spawn).toHaveBeenCalledTimes(1);
});
