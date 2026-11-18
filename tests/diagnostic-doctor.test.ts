import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { diagnosticDoctor, registerDiagnosticDoctor } from "../apps/mcp-server/src/diagnostic-doctor.ts";

afterEach(() => vi.restoreAllMocks());

function client(options: { owner?: boolean; desktop?: boolean } = {}) {
  const agent = new AgentClient([{
    name: "fixture", aliases: ["secondary"],
    url: "http://127.0.0.1:1",
    ...(options.owner ? { userUrl: "http://127.0.0.1:2" } : {}),
    ...(options.desktop ? { desktopUrl: "http://127.0.0.1:3" } : {}),
  }]);
  return agent;
}

it("reports configured root separately from absent owner and never probes an unconfigured desktop", async () => {
  const agent = client();
  const info = vi.spyOn(agent, "info").mockResolvedValue({
    hostname: "synthetic", platform: "linux", runtime: { ready: true },
  });
  const desktop = vi.spyOn(agent, "desktopSessionStatus");
  const result = await diagnosticDoctor(agent, "secondary", { probeTimeoutMs: 200 });
  expect(result).toMatchObject({
    version: 1, device: "fixture", requestedDevice: "secondary", status: "partial",
    coverage: { readonly: true, inputGenerated: false, captureTaken: false,
      physicalPowerVerified: false, processEffectsVerified: false },
  });
  expect(result.stages.find(s => s.identity === "root" && s.name === "agent")).toMatchObject({ state: "ready" });
  expect(result.stages.find(s => s.identity === "owner" && s.name === "agent")).toMatchObject({
    state: "not_configured", cause: "endpoint_not_configured_no_request",
  });
  expect(result.stages.find(s => s.name === "graphical_session")).toMatchObject({ state: "not_configured" });
  expect(result.nextCheck).toContain("owner");
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("fixture", "system", expect.anything());
  expect(desktop).not.toHaveBeenCalled();
});

it("never conflates transport failure with physical power state or discloses raw agent errors", async () => {
  const agent = client({ owner: true });
  const info = vi.spyOn(agent, "info").mockImplementation(async (_device, context) => {
    if (context === "system") throw new Error("PRIVATE_FIXTURE_TOKEN root call failed");
    return { hostname: "synthetic", platform: "linux", runtime: { ready: true } };
  });
  const result = await diagnosticDoctor(agent, "fixture", { includeDesktop: false });
  expect(result.status).toBe("unknown");
  expect(result.stages.find(s => s.identity === "root" && s.name === "agent")).toMatchObject({
    state: "unknown", cause: "agent_probe_failed_power_unknown",
  });
  expect(result.stages.find(s => s.identity === "owner" && s.name === "agent")).toMatchObject({ state: "ready" });
  expect(info).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_TOKEN");
  expect(result.coverage.physicalPowerVerified).toBe(false);
});

it("reports a usable graphical session as capability evidence without generating input or image", async () => {
  const agent = client({ desktop: true });
  const info = vi.spyOn(agent, "info").mockResolvedValue({
    hostname: "synthetic", platform: "linux", runtime: { ready: true },
  });
  const session = vi.spyOn(agent, "desktopSessionStatus").mockResolvedValue({
    interactiveSession: true, inputDesktop: { accessible: true }, captureMayMissSecureDesktop: true,
  });
  const server = new McpServer({ name: "doctor-test", version: "1" });
  registerDiagnosticDoctor(server, agent);
  const sdk = new Client({ name: "doctor-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), sdk.connect(b)]);
    const advertised = (await sdk.listTools()).tools.find(t => t.name === "diagnostic_doctor");
    expect(advertised?.annotations?.readOnlyHint).toBe(true);
    const response = await sdk.callTool({ name: "diagnostic_doctor", arguments: {
      device: "fixture", probeTimeoutMs: 500,
    } });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const result = response.structuredContent as Awaited<ReturnType<typeof diagnosticDoctor>>;
    expect(result.stages.find(s => s.name === "graphical_session")).toMatchObject({ state: "ready" });
    expect(result.stages.find(s => s.name === "capture_capability")).toMatchObject({
      state: "responded", cause: "capture_secure_desktop_boundary_reported",
    });
    expect(result.stages.find(s => s.name === "input_capability")).toMatchObject({
      state: "responded", cause: "input_desktop_accessible_no_input_generated",
    });
    expect(result.coverage).toMatchObject({ readonly: true, captureTaken: false, inputGenerated: false });
    expect(info).toHaveBeenCalledTimes(3);
    expect(session).toHaveBeenCalledTimes(1);
  } finally {
    await sdk.close(); await server.close();
  }
});

it("bounds an unresponsive owner probe without making the root result a false failure", async () => {
  const agent = client({ owner: true });
  vi.spyOn(agent, "info").mockImplementation(async (_device, context, options) => {
    if (context === "system") return { hostname: "synthetic", platform: "linux", runtime: { ready: true } };
    return new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
    });
  });
  const started = performance.now();
  const result = await diagnosticDoctor(agent, "fixture", { probeTimeoutMs: 100, includeDesktop: false });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(result.stages.find(s => s.identity === "root" && s.name === "agent")).toMatchObject({ state: "ready" });
  expect(result.stages.find(s => s.identity === "owner" && s.name === "agent")).toMatchObject({
    state: "unknown", cause: "bounded_probe_expired_power_unknown",
  });
  expect(result.nextCheck).toContain("owner");
});

it("probes graphical session and agent info concurrently instead of stacking timeout budgets", async () => {
  const agent = client({ desktop: true });
  const release = Promise.withResolvers<void>();
  const started = new Set<string>();
  vi.spyOn(agent, "info").mockImplementation(async (_device, context) => {
    started.add("agent:" + context);
    await release.promise;
    return { hostname: "synthetic", platform: "linux", runtime: { ready: true } };
  });
  vi.spyOn(agent, "desktopSessionStatus").mockImplementation(async () => {
    started.add("desktop:session");
    await release.promise;
    return { interactiveSession: false, inputDesktop: { accessible: false } };
  });
  const pending = diagnosticDoctor(agent, "fixture", { probeTimeoutMs: 500 });
  try {
    await vi.waitFor(() => {
      expect(started).toEqual(new Set(["agent:system", "agent:user", "agent:desktop", "desktop:session"]));
    }, { timeout: 350, interval: 10 });
  } finally {
    release.resolve();
    await pending;
  }
  expect((await pending).stages.find(s => s.name === "graphical_session")).toMatchObject({
    state: "unavailable", cause: "no_interactive_session_confirmed",
  });
});

it("honors caller cancellation without translating it into an offline host", async () => {
  const agent = client({ owner: true });
  const info = vi.spyOn(agent, "info");
  await expect(diagnosticDoctor(agent, "fixture", {}, AbortSignal.abort())).rejects.toThrow();
  expect(info).not.toHaveBeenCalled();
});
