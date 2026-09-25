import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import * as fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
import { nativeCommand } from "../apps/agent/src/shell-quote.ts";
import { processAlive } from "../apps/agent/src/process-identity.ts";
import { jobRecoveryPayload } from "../packages/protocol/src/job-recovery.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const module of ["node:fs", "../apps/agent/src/state.ts", "../apps/agent/src/process-identity.ts"]) vi.doUnmock(module);
  vi.resetModules(); vi.unstubAllEnvs();
});
const cases = [
  { code: "ENOSPC", message: "no space left writing job metadata", termination: "unverified" },
  { code: "EACCES", message: "permission denied writing job metadata", termination: "throw" },
  { code: "EIO", message: "fsync failed for job metadata", termination: "verified" },
  { code: "ENOSPC" + "\u0000".repeat(5000), message: "original persistence failure:" + "\u0000".repeat(100_000), termination: "unverified" },
] as const;

it.each(cases)("keeps original $termination persistence diagnostics across real jobStart, HTTP and MCP", async ({ code, message, termination }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc25-official-persist-"));
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));
  await mkdir(path.join(root, "jobs")); vi.stubEnv("RCMCP_STATE_DIR", root);
  const release = path.join(root, "release"), script = path.join(root, "held.cjs");
  await writeFile(script, `const fs=require('node:fs'); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},20);`);
  const pids: number[] = [];
  const stop = async () => {
    await writeFile(release, "go");
    await vi.waitFor(() => expect(pids.some(processAlive)).toBe(false), { timeout: process.platform === "win32" ? 15_000 : 5000 });
  };
  closers.push(stop);
  const persistenceError = Object.assign(new Error(message), { code });
  const writes = vi.fn(() => { throw persistenceError; });
  vi.doMock("../apps/agent/src/state.ts", async original => ({
    ...await original<typeof import("../apps/agent/src/state.ts")>(), atomicWriteJson: writes,
  }));
  vi.doMock("../apps/agent/src/process-identity.ts", async original => ({
    ...await original<typeof import("../apps/agent/src/process-identity.ts")>(),
    terminateVerifiedProcessTreeDetailedAsync: async (pid: number) => {
      pids.push(pid);
      if (termination === "verified") await stop();
      if (termination === "throw") throw new Error("termination fixture failed separately");
      return { terminated: termination === "verified", forced: false, reason: "termination fixture receipt" };
    },
  }));
  if (termination === "verified") vi.doMock("node:fs", () => ({ ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (String(args[0]).endsWith(".stdout.log")) throw new Error("cleanup fixture denied separately");
      return fs.rmSync(...args);
    },
  }));
  const jobs = await import("../apps/agent/src/jobs.ts");
  const app = Fastify(); (await import("../apps/agent/src/extra-routes.ts")).registerExtraRoutes(app);
  const url = await app.listen({ host: "127.0.0.1", port: 0 }); closers.push(() => app.close());
  const client = new AgentClient([{ name: "fixture", url }]);
  const server = new McpServer({ name: "official-persistence", version: "1" }); registerTools(server, client);
  const sdk = new Client({ name: "official-persistence-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), sdk.connect(right)]);
  closers.push(async () => { await sdk.close(); await server.close(); });
  const command = nativeCommand([process.execPath, script]);
  function assertReceipt(value: unknown) {
    const receipt = value as Record<string, any>;
    expect(receipt).toMatchObject({ error: "job_recovery_required", processStatus: termination === "verified" ? "stopped" : "uncertain", terminationVerified: termination === "verified" });
    if (code.length < 100) {
      expect(receipt).toMatchObject({ persistenceError: message, persistenceErrorCode: code });
      expect(receipt.truncatedFields ?? []).not.toContain("persistenceError");
    } else {
      expect(receipt.persistenceError).toMatch(/^original persistence failure:/);
      expect(receipt.persistenceErrorCode).toMatch(/^ENOSPC/);
      expect(receipt.truncatedFields).toEqual(expect.arrayContaining(["persistenceError", "persistenceErrorCode"]));
      expect(Buffer.byteLength(JSON.stringify(receipt.persistenceError))).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(JSON.stringify(receipt.persistenceErrorCode))).toBeLessThanOrEqual(1024);
      expect(jobRecoveryPayload(receipt)).toEqual(receipt); // Re-bounding preserves truthful truncation.
    }
    if (termination === "throw") expect(receipt.terminationError).toBe("termination fixture failed separately");
    else expect(receipt.terminationError).toBeUndefined();
    if (termination === "verified") expect(receipt.cleanupErrors).toEqual([expect.stringContaining("cleanup fixture denied separately")]);
    else expect(receipt.cleanupErrors).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(64 * 1024);
    // Both metadata and best-effort recovery publication fail: the receipt is
    // available in memory/on the wire, never falsely asserted saved to disk.
    expect(fs.existsSync(receipt.metadataPath)).toBe(false);
    expect(fs.existsSync(receipt.stdoutPath)).toBe(true);
  }
  let direct: any;
  try { await jobs.jobStart({ command }); } catch (error) { direct = error; }
  expect(direct).toBeInstanceOf(jobs.JobRecoveryError);
  assertReceipt(direct.toJSON());
  expect(direct).toMatchObject({ persistenceError: direct.toJSON().persistenceError, persistenceErrorCode: direct.toJSON().persistenceErrorCode });
  let http: any;
  try { await client.jobStart("fixture", { command }); } catch (error) { http = error; }
  expect(http).toMatchObject({ name: "AgentRequestError", kind: "http", status: 500 });
  expect(http.recovery, `HTTP failure before the injected recovery receipt: ${String(http.message).slice(0, 1500)}`).toBeDefined();
  assertReceipt(http.recovery);
  const mcp = await sdk.callTool({ name: "job_start", arguments: { device: "fixture", command } });
  expect(mcp.isError).toBe(true); assertReceipt((mcp.structuredContent as Record<string, unknown>)?.recovery);
  const content = mcp.content as Array<{ type: string; text: string }>;
  assertReceipt(JSON.parse(content[0]!.text).recovery);
  expect(pids).toHaveLength(3);
  expect(writes).toHaveBeenCalledTimes(termination === "verified" ? 3 : 6);
}, 60_000);
