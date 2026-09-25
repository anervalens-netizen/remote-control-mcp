import { describe, expect, it } from "vitest";
import { mapLimit } from "../apps/mcp-server/src/concurrency.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("M15 W4 bounded concurrency failure drain", () => {
  it("stops dequeuing and waits for active workers before rejecting", async () => {
    const events: string[] = [];
    const started = performance.now();
    const promise = mapLimit([0, 1, 2, 3], 2, async (item) => {
      events.push(`start:${item}`);
      await delay(item === 0 ? 10 : 80);
      if (item === 0) throw new Error("controlled failure");
      events.push(`finish:${item}`);
      return item;
    });

    await expect(promise).rejects.toThrow("controlled failure");
    const elapsed = performance.now() - started;
    events.push("returned");

    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(events).toContain("finish:1");
    expect(events).not.toContain("start:2");
    expect(events).not.toContain("start:3");
    expect(events.at(-1)).toBe("returned");
  });
});
