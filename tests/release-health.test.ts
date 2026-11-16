import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { runtimeReleaseIdentity } from "../packages/shared/src/release-manifest.ts";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("adds the cached release diagnostic only to authenticated controller health", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "rcmcp-release-health-")); roots.push(root);
  const release = path.join(root, "release"); mkdirSync(release);
  const identity = runtimeReleaseIdentity(release, { legacySha: "0".repeat(40), legacySource: "configured" });
  expect(identity).toMatchObject({ shaBinding: "legacy_declaration", sourceAgreement: "unavailable",
    release: { validation: "unavailable", sourceClaim: "unavailable" } });
  const server = createMcpHttpServer(new AgentClient([]), { token: "synthetic-health-token", sha: identity.sha, releaseIdentity: identity });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  expect(await (await fetch(base + "/health")).json()).toEqual({ ok: true, ready: true, service: "remote-control-mcp" });
  const headers = { authorization: "Bearer synthetic-health-token" };
  for (const route of ["/health", "/health/details"]) {
    const response = await fetch(base + route, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtime: { sha: identity.sha, releaseIdentity: identity } });
  }
});
