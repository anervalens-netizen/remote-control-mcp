import { afterEach, describe, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function harness(
  sessionIdleMs = 1000,
  options: { allowedOrigins?: string[]; maxBodyBytes?: number | null } = {},
) {
  const http = createMcpHttpServer(new AgentClient([], undefined, 1000), {
    token: "m15-http-token",
    sessionIdleMs,
    ...options,
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  closers.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { base };
}

const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "m15", version: "1" } },
};

describe("M15 W5 HTTP contracts", () => {
  it("rejects Origin values that are trusted only by the client-controlled Host header", async () => {
    const { base } = await harness();
    const headers = {
      authorization: "Bearer m15-http-token",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const foreign = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://untrusted-origin.example" },
      body: JSON.stringify(initialize),
    });
    expect(foreign.status).toBe(403);

    const hostDerived = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://spoofed-host.example", host: "spoofed-host.example" },
      body: JSON.stringify(initialize),
    });
    expect(hostDerived.status).toBe(403);

    const absent = await fetch(`${base}/mcp`, {
      method: "POST", headers, body: JSON.stringify(initialize),
    });
    expect(absent.status).toBe(200);
    await absent.body?.cancel();

    const trusted = await harness(1000, { allowedOrigins: ["https://trusted-origin.example"] });
    const explicit = await fetch(`${trusted.base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://trusted-origin.example" },
      body: JSON.stringify(initialize),
    });
    expect(explicit.status).toBe(200);
    await explicit.body?.cancel();
  });

  it("classifies malformed JSON as client input instead of HTTP 500", async () => {
    const { base } = await harness();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer m15-http-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_json" });
  });

  it("exposes the effective request-body limit and has no fixed default cap", async () => {
    const { base } = await harness();
    const health = await (await fetch(`${base}/health`)).json() as any;
    expect(health.runtime.maxBodyBytes).toBeNull();

    const bounded = await harness(1000, { maxBodyBytes: 1024 });
    const boundedHealth = await (await fetch(`${bounded.base}/health`)).json() as any;
    expect(boundedHealth.runtime.maxBodyBytes).toBe(1024);
    const response = await fetch(`${bounded.base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer m15-http-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ payload: "x".repeat(2048) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "payload_too_large" });
  });

  it("reports registered, in-flight and idle session counts separately", async () => {
    const { base } = await harness();
    const healthBefore = await (await fetch(`${base}/health`)).json() as any;
    expect(healthBefore.sessions).toMatchObject({ registered: 0, inFlight: 0, idle: 0 });
    expect(healthBefore.memory.rssBytes).toBeGreaterThan(0);
    expect(healthBefore.memory.heapUsedBytes).toBeGreaterThan(0);

    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer m15-http-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    await response.text();

    const healthAfter = await (await fetch(`${base}/health`)).json() as any;
    expect(healthAfter.sessions.registered).toBe(1);
    expect(healthAfter.sessions.inFlight).toBe(0);
    expect(healthAfter.sessions.idle).toBe(1);
  });

  it("expires idle sessions and keeps health memory telemetry available after cleanup", async () => {
    const { base } = await harness(100);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer m15-http-token",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(200);
    await response.text();

    const registered = await (await fetch(`${base}/health`)).json() as any;
    expect(registered.sessions).toMatchObject({ registered: 1, idle: 1, idleTtlMs: 100 });

    const deadline = Date.now() + 1500;
    let after: any;
    do {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await (await fetch(`${base}/health`)).json() as any;
    } while (after.sessions.registered !== 0 && Date.now() < deadline);

    expect(after.sessions).toMatchObject({ registered: 0, inFlight: 0, idle: 0, idleTtlMs: 100 });
    expect(after.memory.rssBytes).toBeGreaterThan(0);
    expect(after.memory.heapUsedBytes).toBeGreaterThan(0);
  });
});
