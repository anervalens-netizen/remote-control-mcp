import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerAgentIngress } from "../apps/agent/src/ingress-http.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { dispatchesFor } from "../apps/mcp-server/src/agent-dispatch-observer.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function harness() {
  async function endpoint(identity: "root" | "owner") {
    const token = "synthetic-" + identity + "-" + randomUUID();
    const app = Fastify();
    const ingress = registerAgentIngress(app, {
      token, allowUnauthenticated: false, identity, instanceId: randomUUID(),
    });
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.authorization !== "Bearer " + token)
        return reply.code(401).send({ error: "unauthorized" });
    });
    app.get("/v1/info", async () => ({ ready: true, identity }));
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    closers.push(async () => { app.server.closeAllConnections(); await app.close(); });
    return { app, ingress, token, url };
  }
  const alpha = await endpoint("root");
  const beta = await endpoint("owner");
  const agent = new AgentClient([
    { name: "alpha", url: alpha.url, token: alpha.token },
    { name: "beta", url: beta.url, userUrl: beta.url, token: beta.token },
  ]);
  const controller = createMcpHttpServer(agent, { token: "synthetic-controller-only" });
  await new Promise<void>(resolve => controller.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    controller.closeAllConnections();
    await new Promise<void>(resolve => controller.close(() => resolve()));
  });
  const url = new URL("http://127.0.0.1:" + (controller.address() as { port: number }).port + "/mcp");
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: "Bearer synthetic-controller-only" } },
  });
  const sdk = new Client({ name: "rc26-obs04-synthetic-fleet", version: "1" });
  await sdk.connect(transport);
  closers.push(async () => { await sdk.close(); });

  async function window(device: "alpha" | "beta", identity: "root" | "owner",
    action: "open" | "close" | "read", windowId?: string, detailLimit = 0) {
    const reply = await sdk.callTool({ name: "usage_window", arguments: {
      device, identity, action, ...(windowId ? { windowId } : {}), detailLimit,
    } });
    expect(reply.isError, JSON.stringify(reply).slice(0, 2000)).not.toBe(true);
    return reply.structuredContent as any;
  }
  return { alpha, beta, agent, sdk, window };
}

it("reconciles overlapping same-instance windows on two independent agents without crossing route identities", async () => {
  const f = await harness();
  expect((await f.sdk.listTools()).tools.some(tool => tool.name === "usage_window")).toBe(true);
  const alpha = (await f.window("alpha", "root", "open")).report;
  const beta = (await f.window("beta", "owner", "open")).report;
  expect(alpha.windowId).not.toBe(beta.windowId);
  expect(alpha.start.instanceId).not.toBe(beta.start.instanceId);

  // Controller-generated dispatches are tagged independently for each target.
  await f.agent.info("alpha", "system");
  await f.agent.info("beta", "user");
  await f.agent.info("beta", "user");

  // Authenticated direct requests have no controller correlation. Their
  // classification is not inferred from bearer ownership.
  for (let n = 0; n < 3; n++) {
    const response = await f.alpha.app.inject({
      method: "GET", url: "/v1/info", headers: { Authorization: "Bearer " + f.alpha.token },
    });
    expect(response.statusCode).toBe(200);
  }
  // Ingress counts refused direct requests as received traffic too; it
  // does not classify the shared bearer holder as the original client.
  const denied = await f.alpha.app.inject({ method: "GET", url: "/v1/info" });
  expect(denied.statusCode).toBe(401);
  for (let n = 0; n < 2; n++) {
    const response = await f.beta.app.inject({
      method: "GET", url: "/v1/info", headers: { Authorization: "Bearer " + f.beta.token },
    });
    expect(response.statusCode).toBe(200);
  }

  const a = await f.window("alpha", "root", "close", alpha.windowId, 16);
  const b = await f.window("beta", "owner", "close", beta.windowId, 16);
  expect(a.agentStatus.state).toBe("available");
  expect(b.agentStatus.state).toBe("available");
  for (const result of [a, b]) {
    expect(result.report).toMatchObject({
      state: "closed", complete: true, missingEventDetail: 0,
      reconciliation: { collectionResidual: 0 },
    });
    expect(result.report.agentDenominator).toBe(
      result.report.reconciliation.attributed + result.report.reconciliation.unattributed
      + result.report.reconciliation.collectionResidual
    );
  }
  expect(a.report.reconciliation.unattributed).toBe(4);
  expect(b.report.reconciliation.unattributed).toBe(2);
  const observed = dispatchesFor(f.agent).snapshot();
  const alphaPeer = observed.peers.find(peer => peer.device === "alpha" && peer.identity === "root");
  const betaPeer = observed.peers.find(peer => peer.device === "beta" && peer.identity === "owner");
  expect(alphaPeer?.counts.started).toBeGreaterThanOrEqual(2);
  expect(betaPeer?.counts.started).toBeGreaterThanOrEqual(3);
  expect(a.report.reconciliation.attributed).toBeGreaterThanOrEqual(1);
  expect(b.report.reconciliation.attributed).toBeGreaterThanOrEqual(2);
  expect(a.report.dispatches.every((item: any) => item.device === "alpha" && item.identity === "root")).toBe(true);
  expect(b.report.dispatches.every((item: any) => item.device === "beta" && item.identity === "owner")).toBe(true);
  expect(a.report.end.sequence).toBe(f.alpha.ingress.snapshot().sequence);
  expect(b.report.end.sequence).toBe(f.beta.ingress.snapshot().sequence);

  // Reading retained closed windows must not send a new agent request.
  const alphaSequence = f.alpha.ingress.snapshot().sequence;
  const betaSequence = f.beta.ingress.snapshot().sequence;
  const readA = await f.window("alpha", "root", "read", alpha.windowId);
  const readB = await f.window("beta", "owner", "read", beta.windowId);
  expect(readA.report.agentDenominator).toBe(a.report.agentDenominator);
  expect(readB.report.agentDenominator).toBe(b.report.agentDenominator);
  expect(f.alpha.ingress.snapshot().sequence).toBe(alphaSequence);
  expect(f.beta.ingress.snapshot().sequence).toBe(betaSequence);
}, 20_000);

it("denies cross-device window reads without sending remote traffic or losing the original window", async () => {
  const f = await harness();
  const w = (await f.window("alpha", "root", "open")).report;
  const before = [f.alpha.ingress.snapshot().sequence, f.beta.ingress.snapshot().sequence];
  const wrong = await f.sdk.callTool({ name: "usage_window", arguments: {
    device: "beta", identity: "owner", action: "read", windowId: w.windowId,
  } });
  expect(wrong.isError).toBe(true);
  const otherIdentity = await f.sdk.callTool({ name: "usage_window", arguments: {
    device: "alpha", identity: "owner", action: "read", windowId: w.windowId,
  } });
  expect(otherIdentity.isError).toBe(true);
  expect([f.alpha.ingress.snapshot().sequence, f.beta.ingress.snapshot().sequence]).toEqual(before);
  expect((await f.window("alpha", "root", "read", w.windowId)).report.windowId).toBe(w.windowId);
}, 20_000);
