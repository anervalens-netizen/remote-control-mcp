import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fsRead } from "../apps/agent/src/filesystem.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const invalidModes = [
  { versioned: true, maxBytes: 4 },
  { versioned: true, startLine: 1 },
  { versioned: true, lineCount: 1 },
  { versioned: true, tailBytes: 4 },
  { expectedVersion: "1:1:1:1:1", maxBytes: 4 },
  { versioned: false, expectedVersion: "1:1:1:1:1", startLine: 1 },
  { length: 4, maxBytes: 4 },
  { tailBytes: 4, offset: 0 },
  { startLine: 1, encoding: "base64" },
] as const;

it("rejects incompatible modes as HTTP 400 at the actual agent before opening a file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fs-read-contract-"));
  const file = path.join(root, "source.txt");
  await writeFile(file, "alpha\nbeta\nlast\n");
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("RCMCP_")));
  Object.assign(env, {
    RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: String(port),
    RCMCP_STATE_DIR: path.join(root, "state"), RCMCP_AGENT_TOKEN: "fixture-read-contract",
    RCMCP_DESKTOP_ENABLED: "0",
  });
  const child = spawn(process.execPath, [path.resolve("apps/agent/src/index.ts")], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const closed = once(child, "close");
  let diagnostics = "";
  child.stdout.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  const base = `http://127.0.0.1:${port}`;
  const read = async (input: Record<string, unknown>) => {
    const response = await fetch(base + "/v1/fs/read", {
      method: "POST", headers: { authorization: "Bearer fixture-read-contract", "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && child.exitCode === null) {
      try { ready = (await fetch(base + "/health")).ok; if (ready) break; } catch { /* wait for isolated child */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(ready, diagnostics).toBe(true);
    // A missing path makes validation-before-I/O observable: no ENOENT or 500.
    const failures = [];
    for (const modes of invalidModes) failures.push(await read({ path: path.join(root, "never-created"), ...modes }));
    expect(failures.map(result => result.status)).toEqual(invalidModes.map(() => 400));
    for (const result of failures) {
      expect(result.body).toMatchObject({ error: "invalid_request", details: expect.any(Array) });
      expect(result.body).not.toHaveProperty("data");
    }
    expect(failures[0]!.body.details).toContainEqual(expect.objectContaining({ message: expect.stringContaining("byte paging") }));

    const first = await read({ path: file, offset: 0, length: 4, versioned: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ data: "alph", nextOffset: 4, eof: false, sourceVersion: expect.any(String) });
    const second = await read({ path: file, offset: first.body.nextOffset, length: 64, expectedVersion: first.body.sourceVersion });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ data: "a\nbeta\nlast\n", nextOffset: 16, eof: true, sourceVersion: first.body.sourceVersion });
    const line = await read({ path: file, maxBytes: 4, versioned: false });
    expect(line.status).toBe(200);
    expect(line.body).toMatchObject({ data: "alph", nextOffset: 4, partialLine: true, startLine: 1 });
    const continued = await read({ path: file, offset: line.body.nextOffset, startLine: line.body.nextLine, lineCount: 1, maxBytes: 64 });
    expect(continued.status).toBe(200);
    expect(continued.body).toMatchObject({ data: "a\n", nextOffset: 6, nextLine: 2 });
    const tail = await read({ path: file, tailBytes: 5 });
    expect(tail.status).toBe(200);
    expect(tail.body).toMatchObject({ data: "last\n", eof: true });
    const info = await fetch(base + "/v1/info", { headers: { authorization: "Bearer fixture-read-contract" } })
      .then(response => response.json()) as { runtime: { instanceId: string; context: string } };
    const unauthorized = await fetch(base + "/v1/observations/ingress", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(unauthorized.status).toBe(401);
    const observation = await fetch(base + "/v1/observations/ingress", {
      method: "POST", headers: { authorization: "Bearer fixture-read-contract", "content-type": "application/json" },
      body: JSON.stringify({ sampleLimit: 32, seriesLimit: 32, historyLimit: 1 }),
    });
    expect(observation.status).toBe(200);
    const snapshot = await observation.json() as Record<string, any>;
    expect(snapshot.instanceId).toBe(info.runtime.instanceId);
    expect(snapshot.identity).toBe(({ system: "root", user: "owner", desktop: "interactive" } as Record<string, string>)[info.runtime.context] ?? "unknown");
    expect(snapshot.series.filter((series: Record<string, unknown>) => series.route === "/v1/fs/read")).toEqual([
      expect.objectContaining({ route: "/v1/fs/read", method: "POST", entryPoint: "unattributed", authentication: "bearer_verified",
        received: invalidModes.length + 5, completed: invalidModes.length + 5,
        statuses: expect.objectContaining({ success: 5, clientError: invalidModes.length, serverError: 0 }) }),
    ]);
    expect(snapshot.samples).toContainEqual(expect.objectContaining({ route: "/v1/fs/read", phase: "finished", statusCode: 400 }));
    expect(snapshot.samples).toContainEqual(expect.objectContaining({ route: "/v1/fs/read", phase: "finished", statusCode: 200 }));
    expect(snapshot.hookErrors).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain(file);
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30000);

it.each([
  ["stateful", false], ["stateful", true], ["stateless", false], ["stateless", true],
] as const)("keeps fs_read discovery and pre-dispatch validation consistent over %s JSON=%s", async (sessionMode, enableJsonResponse) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fs-read-sdk-"));
  const file = path.join(root, "source.txt");
  await writeFile(file, "alpha\nbeta\n");
  const backend = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  const reads = vi.spyOn(backend, "fsRead").mockImplementation(async (_device, input) => fsRead(input as Parameters<typeof fsRead>[0]));
  const http = createMcpHttpServer(backend, { token: "fixture-contract-token", sessionMode, enableJsonResponse });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`), {
    requestInit: { headers: { authorization: "Bearer fixture-contract-token" } },
  });
  const client = new Client({ name: "fixture-read-client", version: "1" });
  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const single = catalog.tools.find(tool => tool.name === "fs_read")!;
    const batch = catalog.tools.find(tool => tool.name === "batch_read")!;
    const properties = single.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.length!.description).toMatch(/byte paging/i);
    expect(properties.maxBytes!.description).toMatch(/line.*only|only.*line/i);
    expect(properties.versioned!.description).toContain("maxBytes");
    expect(JSON.stringify(batch.inputSchema)).toContain(properties.maxBytes!.description);
    for (const modes of invalidModes) {
      const result = await client.callTool({ name: "fs_read", arguments: { device: "fixture", path: file, ...modes } });
      expect(result.isError).toBe(true);
      expect(reads).not.toHaveBeenCalled();
    }
    const invalidBatch = await client.callTool({ name: "batch_read", arguments: { items: [
      { device: "fixture", path: file, length: 4 },
      { device: "fixture", path: file, versioned: true, maxBytes: 4 },
    ] } });
    expect(invalidBatch.isError).toBe(true);
    expect(reads).not.toHaveBeenCalled();

    const first = await client.callTool({ name: "fs_read", arguments: { device: "fixture", path: file, versioned: true, length: 4 } });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({ data: "alph", nextOffset: 4, eof: false, sourceVersion: expect.any(String) });
    const initial = first.structuredContent as Record<string, unknown>;
    const continuation = await client.callTool({ name: "fs_read", arguments: {
      device: "fixture", path: file, expectedVersion: initial.sourceVersion, offset: initial.nextOffset, length: 64,
    } });
    expect(continuation.isError).not.toBe(true);
    expect(continuation.structuredContent).toMatchObject({ data: "a\nbeta\n", nextOffset: 11, eof: true, sourceVersion: initial.sourceVersion });
    const lines = await client.callTool({ name: "batch_read", arguments: { items: [
      { device: "fixture", path: file, startLine: 2, lineCount: 1, maxBytes: 64 },
      { device: "fixture", path: file, versioned: true, length: 0 },
    ] } });
    expect(lines.isError).not.toBe(true);
    expect(lines.structuredContent).toMatchObject({ partial: false, items: [
      { ok: true, result: { data: "beta\n", startLine: 2, nextLine: 3 } },
      { ok: true, result: { data: "", sourceVersion: initial.sourceVersion, nextOffset: 0 } },
    ] });
    expect(reads).toHaveBeenCalledTimes(4);
  } finally {
    if (transport.sessionId) await transport.terminateSession();
    await client.close();
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    reads.mockRestore();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 30000);
