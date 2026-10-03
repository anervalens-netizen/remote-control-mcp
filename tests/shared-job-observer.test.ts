import { nativeCommand } from "../apps/agent/src/shell-quote.ts";
import { afterEach, expect, it, vi } from "vitest";
import { SharedJobObserver } from "../apps/agent/src/shared-job-observer.ts";
import { jobStart, jobRemove } from "../apps/agent/src/jobs.ts";
import { jobFollow, jobObservers } from "../apps/agent/src/job-follow.ts";
afterEach(() => vi.useRealTimers());
it.each([1, 10, 50])("%i followers share polls, cancellation releases one and slow readers do not queue", async count => {
  let reads = 0;
  const observers = new SharedJobObserver(async () => ({ state: "running", generation: ++reads }));
  const subscribers = Array.from({ length: count }, () => observers.acquire("same-job"));
  expect(await Promise.all(subscribers.map(s => s.sample()))).toEqual(Array(count).fill({ state: "running", generation: 1 }));
  expect(reads).toBe(1);
  subscribers[0]!.release();
  if (count > 1) { expect(await subscribers[1]!.sample()).toMatchObject({ generation: 1 }); expect(observers.snapshot().subscribers).toBe(count - 1); }
  subscribers.forEach(s => s.release()); expect(observers.snapshot()).toMatchObject({ jobs: 0, subscribers: 0 });
  const restarted = observers.acquire("same-job"); await restarted.sample(); expect(reads).toBe(2); restarted.release();
});
it("limits subscribers without evicting existing watchers and isolates identities", async () => {
  const read = vi.fn(async () => 1), a = new SharedJobObserver(read, 200, 2), b = new SharedJobObserver(read);
  const one = a.acquire("job"), two = a.acquire("job"); expect(() => a.acquire("job")).toThrow("capacity");
  const otherIdentity = b.acquire("job"); await Promise.all([one.sample(), two.sample(), otherIdentity.sample()]); expect(read).toHaveBeenCalledTimes(2);
  one.release(); two.release(); otherIdentity.release();
});
it("real durable output keeps independent byte cursors for 50 followers and disk fallback after observer release", async () => {
  const command = nativeCommand([process.execPath, "-e", "process.stdout.write('abcdefghij');process.stderr.write('0123456789');setTimeout(()=>{},600)"]);
  const job = await jobStart({ command });
  try {
    const before = jobObservers.snapshot().polls;
    const abort = new AbortController();
    const cancelled = jobFollow({ id: job.id, waitMs: 3000, maxBytes: 4 }, abort.signal).catch(error => error);
    const followers = Array.from({ length: 50 }, (_, i) => jobFollow({ id: job.id, waitMs: 3000, maxBytes: 4, cursor: { stdout: i % 5, stderr: i % 5 } }));
    abort.abort();
    const results = await Promise.all(followers); expect(await cancelled).toBeInstanceOf(Error);
    for (const [i, result] of results.entries()) {
      expect(result.stdout.data).toBe("abcdefghij".slice(i % 5, i % 5 + 4));
      expect(result.stderr.data).toBe("0123456789".slice(i % 5, i % 5 + 4));
      expect(result.cursor).toEqual({ stdout: i % 5 + 4, stderr: i % 5 + 4 });
    }
    expect(jobObservers.snapshot().polls - before).toBeLessThan(20);
    expect(jobObservers.snapshot()).toMatchObject({ jobs: 0, subscribers: 0 });
    const later = await jobFollow({ id: job.id, cursor: { stdout: 4, stderr: 4 }, maxBytes: 20, waitMs: 0 });
    expect(later.stdout.data).toBe("efghij"); expect(later.outputComplete).toBe(true);
  } finally { await jobRemove(job.id, true); }
}, 15000);
