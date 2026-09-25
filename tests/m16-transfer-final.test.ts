import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { syncDirectory, transferFile, validateDestinationPaths } from "../apps/mcp-server/src/transfer-tools.ts";
import { DEFAULT_TRANSFER_TIMEOUT_MS } from "../packages/protocol/src/deadline.ts";

afterEach(() => vi.useRealTimers());
const base = { sourceDevice: "source", sourcePath: "/source", destinationDevice: "destination", destinationPath: "/destination" };

it.each([undefined, 0])("preserves cancellation and default deadline with an MCP signal (timeout=%s)", async timeoutMs => {
  vi.useFakeTimers();
  const caller = new AbortController();
  let readOptions: { timeoutMs?: number; signal?: AbortSignal } | undefined;
  let writes = 0;
  const client = {
    info: async () => ({ platform: "linux", runtime: { transferStagingVersion: 1 } }),
    fsManage: async (_device: string, input: { operation: string }) => input.operation === "stat" ? { isFile: true, size: 1 } : input.operation === "transfer-stage" ? { temporaryPath: "/destination/stage/payload", directory: "/destination/stage", expectedDestination: "absent" } : { ok: true },
    fsRead: async (_device: string, _input: unknown, _context: unknown, options: typeof readOptions) => {
      readOptions = options;
      return new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true }));
    },
    fsWrite: async () => { writes++; return { ok: true }; },
  } as unknown as AgentClient;
  const result = transferFile(client, { ...base, signal: caller.signal, ...(timeoutMs === undefined ? {} : { timeoutMs }) }).then(() => "unexpected-success", error => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(readOptions?.timeoutMs).toBe(timeoutMs === 0 ? 0 : DEFAULT_TRANSFER_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(DEFAULT_TRANSFER_TIMEOUT_MS);
  if (timeoutMs === 0) {
    expect(readOptions?.signal?.aborted).toBe(false);
    caller.abort(new DOMException("Caller cancelled", "AbortError"));
  }
  expect((await result).name).toBe(timeoutMs === 0 ? "AbortError" : "TimeoutError");
  expect(writes).toBe(0);
});

it("keeps one default whole-sync deadline across direct files with an MCP signal", async () => {
  vi.useFakeTimers();
  const budgets: number[] = [];
  const client = {
    info: async () => ({ platform: "linux", runtime: { transferStagingVersion: 1 } }),
    fsManage: async (_device: string, input: { operation: string }) => input.operation === "stat" ? { isDirectory: true, isFile: true, size: 1 } : { ok: true },
    fsList: async () => ["a", "b"].map(name => ({ name, path: `/source/${name}`, type: "file", size: 1 })),
    directTransfer: async (_source: string, _destination: string, input: { timeoutMs: number }, _sc: unknown, _dc: unknown, signal: AbortSignal) => {
      budgets.push(input.timeoutMs);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve({ ok: true, bytes: 1, chunks: 1 }); }, 1_000_000);
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  } as unknown as AgentClient;
  const result = syncDirectory(client, { ...base, transport: "direct", concurrency: 1, signal: new AbortController().signal }).then(() => "unexpected-success", error => error);
  await vi.advanceTimersByTimeAsync(DEFAULT_TRANSFER_TIMEOUT_MS);
  expect((await result).name).toBe("TimeoutError");
  expect(budgets).toEqual([DEFAULT_TRANSFER_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS - 1_000_000]);
});

it("checks 100,000 Windows target paths without a quadratic pairwise scan", () => {
  const paths = Array.from({ length: 100_000 }, (_, i) => `folder-${Math.floor(i / 100)}/file-${i}.txt`);
  const start = performance.now();
  expect(() => validateDestinationPaths(paths, "win32")).not.toThrow();
  const elapsed = performance.now() - start;
  console.log(`Windows collision preflight: 100000 paths, ${Math.round(elapsed)}ms`);
  expect(elapsed).toBeLessThan(5000);
}, 15000);

it("detects exact and file-prefix collisions independent of discovery order", () => {
  for (const paths of [["Folder", "folder/file"], ["folder/file", "Folder"], ["Name", "name"], ["a/b/c", "A/B"]]) {
    expect(() => validateDestinationPaths(paths, "win32")).toThrow(/collision/);
  }
  expect(() => validateDestinationPaths([{ relative: "folder/file", file: true }, { relative: "folder", file: false }], "win32")).not.toThrow();
  expect(() => validateDestinationPaths([{ relative: "folder", file: false }, { relative: "folder/file", file: true }], "win32")).not.toThrow();
});
