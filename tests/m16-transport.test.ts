import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { assertMcpHttpAuth, createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { syncDirectory, transferFile, validateDestinationPaths } from "../apps/mcp-server/src/transfer-tools.ts";
import { openRawFile, receiveDirectTransfer } from "../apps/agent/src/direct-transfer.ts";
import { MAX_DEADLINE_MS, NODE_TIMER_MAX_MS, createDeadline, withTimeoutGrace } from "../packages/protocol/src/deadline.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).reverse().map((close) => close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "m16-transport", version: "1" } },
};

async function httpHarness(client: AgentClient = new AgentClient([], undefined, 1000), sessionIdleMs = 1000) {
  const http = createMcpHttpServer(client, { token: "m16-token", sessionIdleMs });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  closers.push(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  return { base };
}

async function initializeSession(base: string): Promise<string> {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer m16-token", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(initialize),
  });
  expect(response.status).toBe(200);
  await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP initialize did not return a session id");
  return sessionId;
}

async function health(base: string): Promise<any> {
  return await (await fetch(`${base}/health`)).json();
}

describe("M16 transport remediation", () => {
  it("shares immutable tool registry, deletes sessions, and records GC measurements", async () => {
    const { base } = await httpHarness();
    const before = await health(base);
    const ids = await Promise.all([initializeSession(base), initializeSession(base), initializeSession(base)]);
    const afterCreate = await health(base);
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    gc?.();
    const measuredCreateHeap = (await health(base)).memory.heapUsedBytes;
    expect(before.sessions.registered).toBe(0);
    expect(afterCreate.sessions.registered).toBe(3);
    expect(afterCreate.sessions.toolRegistryBuilds).toBe(1);
    expect(measuredCreateHeap).toBeGreaterThan(0);

    for (const id of ids) {
      const response = await fetch(`${base}/mcp`, { method: "DELETE", headers: { authorization: "Bearer m16-token", "mcp-session-id": id } });
      expect(response.status).toBe(200);
    }
    gc?.();
    const afterDelete = await health(base);
    expect(afterDelete.sessions).toMatchObject({ registered: 0, inFlight: 0, idle: 0, idleTtlMs: 1000, toolRegistryBuilds: 1 });
    expect(afterDelete.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(typeof measuredCreateHeap).toBe("number");
  });

  it("does not expire an active long request, then expires it while idle", async () => {
    class SlowClient extends AgentClient {
      override desktopBatch(_device: string, _input: any, _signal?: AbortSignal): Promise<unknown> {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 180));
      }
    }
    const { base } = await httpHarness(new SlowClient([], undefined, 1000), 50);
    const id = await initializeSession(base);
    const request = fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer m16-token", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": id },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "desktop_batch", arguments: { device: "pc", actions: [{ kind: "wait", ms: 1 }] } } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await health(base)).sessions).toMatchObject({ registered: 1, inFlight: 1 });
    expect((await request).status).toBe(200);
    const deadline = Date.now() + 1000;
    let state = await health(base);
    while (state.sessions.registered !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = await health(base);
    }
    expect(state.sessions.registered).toBe(0);
  });

  it("handles zero and overflow-safe deadlines without immediate cancellation", () => {
    const external = new AbortController();
    const disabled = createDeadline(0, external.signal);
    expect(disabled.signal?.aborted).toBe(false);
    external.abort();
    expect(disabled.signal?.aborted).toBe(true);
    disabled.dispose();
    expect(withTimeoutGrace(MAX_DEADLINE_MS)).toBe(MAX_DEADLINE_MS);

    vi.useFakeTimers();
    const deadline = createDeadline(NODE_TIMER_MAX_MS + 1);
    vi.advanceTimersByTime(NODE_TIMER_MAX_MS);
    expect(deadline.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal?.aborted).toBe(true);
    deadline.dispose();
  });

  it("applies the same relay deadline to nested reads before activation", async () => {
    let readSignal: AbortSignal | undefined;
    let writes = 0;
    let moves = 0;
    const client = {
      info: async () => ({ platform: "linux", runtime: { transferStagingVersion: 1 } }),
      fsManage: async (_device: string, input: { operation: string }) => {
        if (input.operation === "transfer-stage") return { temporaryPath: "/destination/stage/payload", directory: "/destination/stage", expectedDestination: "absent" };
        if (input.operation === "stat") return { isFile: true, size: 1, modifiedAt: "2026-09-20T00:00:00.000Z" };
        if (input.operation === "transfer-finalize") moves += 1;
        return { ok: true };
      },
      fsRead: async (_device: string, _input: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        readSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true }));
      },
      fsWrite: async () => { writes += 1; return { ok: true }; },
    };
    await expect(transferFile(client as any, {
      sourceDevice: "source", sourcePath: "/source", destinationDevice: "destination", destinationPath: "/destination", timeoutMs: 20,
    })).rejects.toThrow();
    expect(readSignal?.aborted).toBe(true);
    expect(writes).toBe(0);
    expect(moves).toBe(0);
  });

  it("rejects Windows collisions and invalid names before destination mutation", async () => {
    expect(() => validateDestinationPaths([{ relative: "folder", file: false }, { relative: "folder/file.txt", file: true }], "win32")).not.toThrow();
    expect(() => validateDestinationPaths(["Report.txt", "report.TXT"], "win32")).toThrow(/collision/);
    expect(() => validateDestinationPaths(["CON.txt"], "win32")).toThrow(/reserved/);

    let destinationMutations = 0;
    const client = {
      info: async (device: string) => ({ platform: device === "destination" ? "win32" : "linux", runtime: { transferStagingVersion: 1 } }),
      fsManage: async (device: string, input: { operation: string }) => {
        if (device === "source" && input.operation === "stat") return { isDirectory: true, size: 0 };
        if (device === "destination") destinationMutations += 1;
        return { ok: true };
      },
      fsList: async () => [
        { name: "Report.txt", path: "/source/Report.txt", type: "file", size: 1 },
        { name: "report.TXT", path: "/source/report.TXT", type: "file", size: 1 },
      ],
    };
    await expect(syncDirectory(client as any, { sourceDevice: "source", sourcePath: "/source", destinationDevice: "destination", destinationPath: "C:\\dest" })).rejects.toThrow(/collision/);
    expect(destinationMutations).toBe(0);
  });

  it("keeps production HTTP auth fail-closed while allowing an explicit dev opt-out", () => {
    expect(() => assertMcpHttpAuth(undefined)).toThrow(/RCMCP_MCP_TOKEN/);
    expect(() => assertMcpHttpAuth(undefined, true)).not.toThrow();
    expect(() => assertMcpHttpAuth("configured")).not.toThrow();
  });

  it("detects a remote source mutation before direct destination activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-m16-direct-")); roots.push(root);
    const sourcePath = path.join(root, "source.bin");
    const destinationPath = path.join(root, "destination.bin");
    await writeFile(sourcePath, "stable");
    await writeFile(destinationPath, "old");
    const methods: string[] = [];
    let mutationResolve: (() => void) | undefined;
    const mutationDone = new Promise<void>((resolve) => { mutationResolve = resolve; });
    const sourceServer = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      methods.push(request.method ?? "unknown");
      const raw = await openRawFile(sourcePath);
      response.setHeader("content-length", raw.size);
      response.setHeader("x-rcmcp-modified-at", raw.modifiedAt);
      response.setHeader("x-rcmcp-sha256", raw.sha256);
      response.setHeader("x-rcmcp-source-confirmation", "head");
      if (request.method === "HEAD") { await mutationDone; const confirmed = await openRawFile(sourcePath); response.setHeader("content-length", confirmed.size); response.setHeader("x-rcmcp-modified-at", confirmed.modifiedAt); response.setHeader("x-rcmcp-sha256", confirmed.sha256); response.end(); return; }
      response.write(Buffer.from("stable"));
      await writeFile(sourcePath, "changed");
      mutationResolve?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      response.end();
    });
    servers.push(sourceServer);
    await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
    const sourceBase = `http://127.0.0.1:${(sourceServer.address() as { port: number }).port}`;
    await expect(receiveDirectTransfer({ sourceBase, sourcePath, destinationPath, timeoutMs: 10_000 })).rejects.toThrow(/Source changed/);
    expect(await readFile(destinationPath, "utf8")).toBe("old");
  });
});

it("bounds best-effort relay cleanup when the destination is unresponsive", async () => {
  let cleanupSignal: AbortSignal | undefined;
  const client = {
    info: async () => ({platform:"linux",runtime:{transferStagingVersion:1}}),
    fsManage: async (_device: string, input: {operation:string}, _context: unknown, options?: {signal?:AbortSignal}) => {
      if(input.operation==="stat")return {isFile:true,size:1,modifiedAt:"2026-09-20T00:00:00.000Z"};
      if(input.operation==="transfer-stage") return {temporaryPath:"/destination/stage/payload",directory:"/destination/stage",expectedDestination:"absent"};
      if(input.operation==="delete") {cleanupSignal=options?.signal; return new Promise(()=>{});}
      throw new Error("unexpected mutation");
    },
    fsRead: async (_device:string,_input:unknown,_context:unknown,options?:{signal?:AbortSignal}) => new Promise((_resolve,reject)=>options?.signal?.addEventListener("abort",()=>reject(new Error("original read deadline")),{once:true})),
  };
  const started=performance.now();
  await expect(transferFile(client as any,{sourceDevice:"source",sourcePath:"/source",destinationDevice:"destination",destinationPath:"/destination",timeoutMs:20})).rejects.toThrow("original read deadline");
  expect(performance.now()-started).toBeLessThan(1000);
  expect(cleanupSignal?.aborted).toBe(true);
});
