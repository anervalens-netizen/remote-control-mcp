import { afterEach, expect, it, vi } from "vitest";
import { transferFile } from "../apps/mcp-server/src/transfer-tools.ts";
import type { AgentClient, AgentRequestOptions } from "../apps/mcp-server/src/agent-client.ts";

afterEach(() => vi.useRealTimers());

it("starts the exact 250ms cleanup clock after a slow transfer, without inheriting its deadline", async () => {
  vi.useFakeTimers();
  let cleanupOptions: AgentRequestOptions | undefined;
  let cleanupCalls = 0, settled = false;
  const client = {
    info: async () => ({ platform: "linux", runtime: { transferStagingVersion: 1 } }),
    fsWrite: async () => ({ ok: true }),
    fsManage: async (_device: string, input: { operation: string }, _context: unknown, options: AgentRequestOptions) => {
      if (input.operation === "stat") return { isFile: true, size: 0 };
      if (input.operation === "transfer-stage") {
        await new Promise(resolve => setTimeout(resolve, 3000));
        return { temporaryPath: "/stage/payload", directory: "/stage", expectedDestination: "absent" };
      }
      if (input.operation === "transfer-finalize") return { ok: true, atomic: true };
      if (input.operation === "delete") {
        cleanupCalls++; cleanupOptions = options;
        return new Promise(() => {});
      }
      throw new Error(`Unexpected fixture operation: ${input.operation}`);
    },
  };
  const pending = transferFile(client as unknown as AgentClient, {
    sourceDevice: "source", sourcePath: "/source", destinationDevice: "destination",
    destinationPath: "/destination", timeoutMs: 5000,
  }).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(3000);
  expect(cleanupCalls).toBe(1);
  expect(cleanupOptions?.timeoutMs).toBe(250);
  expect(cleanupOptions?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(249);
  expect(settled).toBe(false);
  expect(cleanupOptions?.signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({
    ok: true, cleanupPending: true, cleanupPath: "/stage",
    cleanupError: expect.stringContaining("250ms"),
  });
  expect(cleanupOptions?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
