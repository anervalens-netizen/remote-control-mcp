import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "../apps/agent/src/exec.ts";
import { fsWrite, syncInPlaceWrite } from "../apps/agent/src/filesystem.ts";
import { search } from "../apps/agent/src/search.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerHighLevelTools } from "../apps/mcp-server/src/high-level-tools.ts";
import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";
import { compactStructuredContent, STRUCTURED_CONTENT_MAX_BYTES } from "../apps/mcp-server/src/tool-contract-defaults.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

const execResult = {
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  stdoutBytes: 0,
  stderrBytes: 0,
  stdoutTruncated: false,
  stderrTruncated: false,
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForFile(file: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await delay(10);
  }
  throw new Error("fixture did not become ready: " + file);
}

describe("Issue #35 audit remediation", () => {
  it("stops queued batch_exec dispatch after MCP caller cancellation", async () => {
    const invoked: string[] = [];
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const agent = new AgentClient([{ name: "pc", url: "http://unused.invalid" }]);
    agent.exec = async (_name, request, _context, options = {}) => {
      invoked.push(request.command);
      if (request.command === "fixture-1") {
        markStarted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          const aborted = () => {
            clearTimeout(timer);
            reject(options.signal?.reason ?? new Error("cancelled"));
          };
          options.signal?.addEventListener("abort", aborted, { once: true });
          if (options.signal?.aborted) aborted();
        });
      }
      return execResult;
    };

    const server = new McpServer({ name: "issue35-batch", version: "1" });
    registerHighLevelTools(server, agent);
    const client = new Client({ name: "issue35-client", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const controller = new AbortController();
      const pending = client.callTool({
        name: "batch_exec",
        arguments: {
          concurrency: 1,
          items: [1, 2, 3].map((item) => ({ device: "pc", command: `fixture-${item}` })),
        },
      }, undefined, { signal: controller.signal });
      void pending.catch(() => undefined);
      await firstStarted;
      controller.abort(new Error("cancel audit fixture"));
      await expect(pending).rejects.toThrow();
      await delay(100);
      expect(invoked).toEqual(["fixture-1"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("cancels already-started foreground execution without reporting a timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue35-exec-"));
    roots.push(root);
    const ready = path.join(root, "ready.txt");
    const controller = new AbortController();
    const running = process.platform === "win32"
      ? runProcess("powershell.exe", [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `Set-Content -LiteralPath '${ready.replaceAll("'", "''")}' -Value READY; Start-Sleep -Seconds 20`,
        ], { timeoutMs: 0, signal: controller.signal })
      : runProcess("/bin/bash", [
          "--noprofile", "--norc", "-c",
          `echo READY > '${ready.replaceAll("'", "'\\''")}'; trap '' TERM; sleep 20`,
        ], { timeoutMs: 0, signal: controller.signal });

    await waitForFile(ready);
    controller.abort(new Error("cancel foreground fixture"));
    const result = await running;
    expect(result.cancellationRequested).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(3000);
    if (process.platform !== "win32") {
      expect(result.terminationVerified).toBe(true);
      expect(result.cancelled).toBe(true);
    } else if (result.terminationVerified !== true) {
      expect(result.cancelled).not.toBe(true);
    }
  });

  it.skipIf(process.platform !== "win32")("binds Windows identity before an immediate post-spawn caller abort", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue35-win-abort-"));
    roots.push(root);
    const marker = path.join(root, "late.txt");
    const controller = new AbortController();
    const running = runProcess("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Start-Sleep -Milliseconds 900; Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value LATE`,
    ], { timeoutMs: 0, signal: controller.signal });
    queueMicrotask(() => controller.abort(new Error("startup-race fixture")));
    const result = await running;
    expect(result.cancellationRequested).toBe(true);
    expect(result.timedOut).toBe(false);
    if (result.terminationVerified !== true) expect(result.cancelled).not.toBe(true);
    await delay(1200);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects malformed Base64 before changing files or creating parents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue35-b64-"));
    roots.push(root);
    const existing = path.join(root, "existing.bin");
    await writeFile(existing, "before");

    await expect(fsWrite({ path: existing, data: "!!!", encoding: "base64" })).rejects.toThrow("Invalid Base64");
    expect(await readFile(existing, "utf8")).toBe("before");

    const nested = path.join(root, "missing", "new.bin");
    await expect(fsWrite({ path: nested, data: "A", encoding: "base64", createParents: true })).rejects.toThrow("Invalid Base64");
    expect(existsSync(path.dirname(nested))).toBe(false);

    const valid = await fsWrite({ path: existing, data: "YQ", encoding: "base64" });
    expect(valid.writtenBytes).toBe(1);
    expect(await readFile(existing, "utf8")).toBe("a");

    const empty = await fsWrite({ path: existing, data: "", encoding: "base64" });
    expect(empty.writtenBytes).toBe(0);
    expect(await readFile(existing)).toHaveLength(0);
  });

  it("attempts fsync on non-regular targets before classifying sync as unsupported", async () => {
    let syncCalls = 0;
    const syncable = {
      stat: async () => ({ isFile: () => false }),
      sync: async () => { syncCalls += 1; },
    } as unknown as Parameters<typeof syncInPlaceWrite>[0];
    await expect(syncInPlaceWrite(syncable)).resolves.toEqual({ dataSynced: true });
    expect(syncCalls).toBe(1);

    const unsupported = {
      stat: async () => ({ isFile: () => false }),
      sync: async () => { throw Object.assign(new Error("unsupported sync"), { code: "EINVAL" }); },
    } as unknown as Parameters<typeof syncInPlaceWrite>[0];
    await expect(syncInPlaceWrite(unsupported)).resolves.toMatchObject({
      dataSynced: false,
      dataSyncSkipped: true,
      dataSyncReason: "non_regular_target",
    });

    for (const regular of [true, false]) {
      const hardFailure = {
        stat: async () => ({ isFile: () => regular }),
        sync: async () => { throw Object.assign(new Error("storage sync failed"), { code: "EIO" }); },
      } as unknown as Parameters<typeof syncInPlaceWrite>[0];
      await expect(syncInPlaceWrite(hardFailure)).rejects.toMatchObject({ code: "EIO" });
    }
  });

  it.skipIf(process.platform === "win32")("writes special targets without turning unsupported fsync into a false operation failure", async () => {
    const rewrite = await fsWrite({ path: "/dev/null", data: "rewrite" });
    expect(rewrite).toMatchObject({
      mode: "rewrite",
      writtenBytes: 7,
      durable: false,
      dataSynced: false,
      dataSyncSkipped: true,
      dataSyncReason: "non_regular_target",
      targetType: "special",
    });

    const append = await fsWrite({ path: "/dev/null", data: "append", mode: "append" });
    expect(append).toMatchObject({
      mode: "append",
      writtenBytes: 6,
      durable: false,
      dataSynced: false,
      dataSyncSkipped: true,
      dataSyncReason: "non_regular_target",
    });
  });

  it("enforces the structuredContent byte budget for wide nested objects without breaking the semantic shape", () => {
    const value = {
      sessionId: "audit", executionId: "fixture", status: "completed", activeStepIndex: null, outcome: "settled",
      ok: true,
      executed: 4,
      results: Array.from({ length: 4 }, (_, actionIndex) => ({
        index: actionIndex,
        action: "evaluate",
        ok: true,
        result: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`key-${actionIndex}-${index}`, index])),
      })),
      pages: [],
    };
    const compacted = compactStructuredContent(value, STRUCTURED_CONTENT_MAX_BYTES, toolResultSchemas.browser_action);
    expect(compacted.structuredContentTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(compacted), "utf8")).toBeLessThanOrEqual(STRUCTURED_CONTENT_MAX_BYTES);
    expect(() => toolResultSchemas.browser_action.parse(compacted)).not.toThrow();
  });

  it("reports maxResults truncation for file-mode search while preserving the legacy array when exhaustive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-issue35-search-"));
    roots.push(root);
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "b.txt"), "b");

    const limited = await search({ path: root, pattern: ".txt", mode: "files", literal: true, maxResults: 1 });
    expect(Array.isArray(limited)).toBe(false);
    expect(limited).toMatchObject({
      limited: true,
      truncated: true,
      countTruncated: true,
      maxResults: 1,
    });
    if (!Array.isArray(limited)) {
      const fileLimited = limited as { results: Array<{ path: string }>; byteTruncated?: true };
      expect(fileLimited.results).toHaveLength(1);
      expect(fileLimited.byteTruncated).toBeUndefined();
    }

    const exhaustive = await search({ path: root, pattern: ".txt", mode: "files", literal: true, maxResults: 3 });
    expect(Array.isArray(exhaustive)).toBe(true);
    expect(exhaustive).toHaveLength(2);

    const exact = await search({ path: root, pattern: ".txt", mode: "files", literal: true, maxResults: 2 });
    expect(Array.isArray(exact)).toBe(true);
    expect(exact).toHaveLength(2);
  });
});
