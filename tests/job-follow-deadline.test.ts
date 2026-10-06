import { afterEach, expect, it, vi } from "vitest";
import { jobFollow, jobObservers } from "../apps/agent/src/job-follow.ts";

vi.mock("../apps/agent/src/jobs.ts", () => ({
  jobStatusAsync: vi.fn(),
  jobStatusSnapshot: () => ({ id: "fixture", state: "running", stdoutBytes: 0, stderrBytes: 0 }),
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
