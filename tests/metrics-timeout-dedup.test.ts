import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ statfs: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<object>(), statfs: mock.statfs }));
afterEach(() => { vi.useRealTimers(); vi.resetModules(); mock.statfs.mockReset(); });
it("keeps uncancellable timed-out statfs in flight across repeated callers", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  mock.statfs.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { systemMetrics } = await import("../apps/agent/src/system.ts");
  for (let i=0;i<3;i++) {
    const pending=systemMetrics("light");
    await vi.advanceTimersByTimeAsync(1501);
    expect(await pending).toMatchObject({metricsStatus:"partial",warnings:expect.arrayContaining(["filesystem_probe_timeout"])});
  }
  expect(mock.statfs).toHaveBeenCalledTimes(1);
  const joined = systemMetrics("light");
  finish({blocks:100,bfree:60,bavail:60,bsize:4096});
  await vi.advanceTimersByTimeAsync(0);
  expect(await joined).toMatchObject({metricsStatus:"ok",filesystemCached:true});
  await vi.advanceTimersByTimeAsync(1001);
  mock.statfs.mockResolvedValue({blocks:100,bfree:60,bavail:60,bsize:4096});
  await systemMetrics("light");
  expect(mock.statfs).toHaveBeenCalledTimes(2);
});
