import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
vi.mock("../apps/agent/src/system.ts", async original => {
  const module = await original<typeof import("../apps/agent/src/system.ts")>();
  return { ...module, serviceManage: vi.fn(async (input: { name: string; action: string }) => ({ Id: "synthetic.service", Name: "synthetic", ActiveState: "active", State: "Running", action: input.action === "status" ? undefined : input.action })) };
});
import { serviceManage } from "../apps/agent/src/system.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { mkdtempSync } from "node:fs";
import path from "node:path";
beforeEach(() => { vi.stubEnv("RCMCP_COORDINATION_DIR", mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "service-coord-"))); });
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
it("service aliases share a fence while status, raw exec and independent resources remain available under backpressure", async () => {
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  let rawEffects = 0;
  app.post("/v1/exec", async () => ({ effects: ++rawEffects }));
  const reserve = (resource: unknown) => app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "acquire", resource } });
  const first = await reserve({ kind: "service", name: "synthetic-alias" }); expect(first.statusCode).toBe(200);
  const mutation = await app.inject({ method: "POST", url: "/v1/service", payload: { name: "synthetic", action: "restart" } });
  expect(mutation.statusCode).toBe(409); expect(mutation.json().details.reason).toBe("writer_reserved");
  expect(vi.mocked(serviceManage).mock.calls.every(([input]) => input.action === "status")).toBe(true);
  for (let i = 0; i < 3; i++) {
    const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "independent-"));
    expect((await reserve({ kind: "repo", path: root })).statusCode).toBe(200);
  }
  const fifth = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "backpressure-"));
  expect((await reserve({ kind: "repo", path: fifth })).json().details.reason).toBe("device_backpressure");
  const started = performance.now();
  const [status, raw] = await Promise.all([
    app.inject({ method: "POST", url: "/v1/service", payload: { name: "synthetic", action: "status" } }),
    app.inject({ method: "POST", url: "/v1/exec", payload: { command: "synthetic" } }),
  ]);
  expect(status.statusCode).toBe(200); expect(raw.json()).toEqual({ effects: 1 });
  expect(performance.now() - started).toBeLessThan(250);
  const released = await app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "release", resource: { kind: "service", name: "synthetic" }, token: first.json().token } });
  expect(released.statusCode).toBe(200);
  expect((await reserve({ kind: "repo", path: fifth })).statusCode).toBe(200);
});

it("a rejected duplicate token cannot settle the original active invocation", async () => {
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const resource = { kind: "service", name: "synthetic" };
  const first = await app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "acquire", resource } });
  expect(first.statusCode).toBe(200);
  const token = first.json().token;
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const originalImplementation = vi.mocked(serviceManage).getMockImplementation()!;
  let effects = 0;
  vi.mocked(serviceManage).mockImplementation(async input => {
    if (input.action !== "status") { effects++; entered.resolve(); await finish.promise; }
    return originalImplementation(input);
  });
  const payload = { name: "synthetic", action: "restart", coordination: token };
  const original = app.inject({ method: "POST", url: "/v1/service", payload }).then(response => response);
  try {
    await entered.promise;
    const duplicate = await app.inject({ method: "POST", url: "/v1/service", payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().details.reason).toBe("writer_not_reserved");
    const active = await app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "inspect", resource } });
    expect(active.json().record).toMatchObject({ state: "active", operationId: token.operationId, conflictReason: null });
    expect(effects).toBe(1);
  } finally { finish.resolve(); }
  const settled = await original;
  expect(settled.statusCode).toBe(200);
  expect(settled.json().coordination).toMatchObject({ state: "released", operationId: token.operationId, conflictReason: null });
  expect((await app.inject({ method: "POST", url: "/v1/coordination", payload: { action: "acquire", resource } })).statusCode).toBe(200);
  vi.mocked(serviceManage).mockImplementation(originalImplementation);
});

it.each([1, 2])("service probe/parse failure on observation %s permits a corrected request", async observation => {
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const implementation = vi.mocked(serviceManage).getMockImplementation()!;
  let probes = 0;
  vi.mocked(serviceManage).mockImplementation(async input => {
    if (input.action === "status" && ++probes === observation) throw new SyntaxError("synthetic status parse failure");
    return implementation(input);
  });
  const payload = { name: "synthetic", action: "restart" };
  const failed = await app.inject({ method: "POST", url: "/v1/service", payload });
  expect(failed.statusCode).toBe(500);
  expect(vi.mocked(serviceManage).mock.calls.every(([input]) => input.action === "status")).toBe(true);
  vi.mocked(serviceManage).mockImplementation(implementation);
  const corrected = await app.inject({ method: "POST", url: "/v1/service", payload });
  expect(corrected.statusCode).toBe(200);
  expect(corrected.json().coordination.state).toBe("released");
});

it("service status failure after submitting a mutation remains uncertain", async () => {
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const implementation = vi.mocked(serviceManage).getMockImplementation()!;
  vi.mocked(serviceManage).mockImplementation(async input => {
    if (input.action !== "status") throw new SyntaxError("synthetic post-effect status failure");
    return implementation(input);
  });
  try {
    const payload = { name: "synthetic", action: "restart" };
    expect((await app.inject({ method: "POST", url: "/v1/service", payload })).statusCode).toBe(500);
    const retry = await app.inject({ method: "POST", url: "/v1/service", payload });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().details).toMatchObject({ reason: "active_or_uncertain_writer", coordination: { state: "uncertain" } });
  } finally { vi.mocked(serviceManage).mockImplementation(implementation); }
});
