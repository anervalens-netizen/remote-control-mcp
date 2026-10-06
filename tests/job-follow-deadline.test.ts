import { afterEach, expect, it, vi } from "vitest";
import * as jobs from "../apps/agent/src/jobs.ts";
import { jobFollow, jobObservers } from "../apps/agent/src/job-follow.ts";

vi.mock("../apps/agent/src/jobs.ts", () => ({
  jobStatusAsync: vi.fn(),
  jobStatusSnapshot: vi.fn(() => ({ id: "fixture", state: "running", stdoutBytes: 0, stderrBytes: 0 })),
  jobOutput: () => ({ data: "", offset: 0, totalBytes: 0, eof: true }),
}));
afterEach(() => vi.restoreAllMocks());

it.each(["initial", "later"] as const)("bounds a blocked %s status sample and releases its subscriber", async phase => {
  const release = vi.fn();
  const pending = new Promise<never>(() => {});
  const sample = vi.fn((): any => pending);
  if (phase === "later") sample.mockResolvedValueOnce({ id: "fixture", state: "running", stdoutBytes: 0, stderrBytes: 0 });
  vi.spyOn(jobObservers, "acquire").mockReturnValue({ sample, release });
  const started = performance.now();
  const result = await jobFollow({ id: "fixture", waitMs: phase === "initial" ? 30 : 400 });
  expect(result).toMatchObject({ state: "running", terminal: false, waitExpired: true, cursor: { stdout: 0, stderr: 0 } });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(sample).toHaveBeenCalledTimes(phase === "initial" ? 1 : 2);
  expect(release).toHaveBeenCalledTimes(1);
});

it("does not begin another sample after sleeping through the remaining deadline", async () => {
  const release = vi.fn(), sample = vi.fn().mockResolvedValue({ id: "fixture", state: "running", stdoutBytes: 0, stderrBytes: 0 });
  vi.spyOn(jobObservers, "acquire").mockReturnValue({ sample, release });
  expect(await jobFollow({ id: "fixture", waitMs: 30 })).toMatchObject({ waitExpired: true });
  expect(sample).toHaveBeenCalledTimes(1);
});


it("zero-wait pagination advances reconciliation without waiting for a slow manager", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const sample = vi.mocked(jobs.jobStatusAsync).mockImplementationOnce(async () => {
    await pending;
    const terminal = { id: "fixture", state: "completed", exitCode: 0, stdoutBytes: 0, stderrBytes: 0 } as any;
    vi.mocked(jobs.jobStatusSnapshot).mockReturnValue(terminal);
    return terminal;
  });
  const started = performance.now();
  expect(await jobFollow({ id: "fixture", waitMs: 0 })).toMatchObject({ terminal: false, waitExpired: true });
  expect(performance.now() - started).toBeLessThan(500);
  expect(sample).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  await Promise.resolve();
  expect(await jobFollow({ id: "fixture", waitMs: 0 })).toMatchObject({
    state: "completed", terminal: true, outputComplete: true, waitExpired: false,
  });
});
