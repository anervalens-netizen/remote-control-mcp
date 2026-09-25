import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jobFollow } from "../apps/agent/src/job-follow.ts";
import { jobCancel, jobLineage, jobList, jobStatus, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";
import { installDefaultToolOutputContracts } from "../apps/mcp-server/src/tool-contract-defaults.ts";
import { toolResultSchemas } from "../apps/mcp-server/src/semantic-result-schemas.ts";

it.each(["linux:boot:123", "win:638990000000000000"])("keeps compact status/follow/list and complete paginated native evidence (%s)", async (identity) => {
  const root = path.join(process.env.RCMCP_STATE_DIR!, "jobs");
  mkdirSync(root, { recursive: true });
  const id = identity.startsWith("win") ? "windows-fixture" : "linux-fixture";
  const trackedProcesses = Array.from({ length: 559 }, (_, i) => ({ pid: 10000 + i, identity: identity + i }));
  const meta = { id, command: "fixture", cwd: null, pid: 10000, state: "lost", startedAt: new Date().toISOString(),
    processIdentity: identity, trackedProcesses, terminationVerified: false, terminationForced: true,
    terminationVerification: "partial_windows_job", terminationVerificationScope: "root_and_descendants_created_after_attach",
    terminationReason: "fixture uncertainty", recoveryReason: "fixture uncertainty", cancellationError: "fixture error",
    stdoutPath: path.join(root, id + ".stdout.log"), stderrPath: path.join(root, id + ".stderr.log"), exitPath: path.join(root, id + ".exit") };
  const file = path.join(root, id + ".json");
  writeFileSync(file, JSON.stringify(meta));
  writeFileSync(path.join(root, id + ".progress"), JSON.stringify({ state: "running", phase: "verify" }));
  const flags = { processIdentity: identity, terminationVerified: false, terminationForced: true, terminationVerification: "partial_windows_job",
    terminationVerificationScope: "root_and_descendants_created_after_attach", terminationReason: "fixture uncertainty",
    recoveryReason: "fixture uncertainty", cancellationError: "fixture error", progressInterrupted: true, progress: { state: "running", phase: "verify" }, trackedProcessCount: 559 };
  for (const value of [jobStatus(id), await jobStatusAsync(id), await jobCancel(id), await jobFollow({ id, waitMs: 0, maxBytes: 1 }), jobList().find(item => item.id === id)]) {
    expect(value).toMatchObject(flags);
    expect(value).not.toHaveProperty("trackedProcesses");
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(2500);
  }
  const all = [];
  let offset = 0;
  do {
    const page = jobLineage({ id, offset, limit: 73 });
    expect(toolResultSchemas.job_lineage.safeParse({ ...page, identity: "root", context: "system" }).success).toBe(true);
    all.push(...page.items);offset = page.nextOffset;
    if (!page.hasMore) break;
  } while (true);
  expect(all).toEqual(trackedProcesses);
  expect(jobLineage({ id, offset: 9999 })).toMatchObject({ items: [], nextOffset: 559, hasMore: false });
  expect(() => jobLineage({ id, limit: 257 })).toThrow();
  expect(JSON.parse(readFileSync(file, "utf8")).trackedProcesses).toEqual(trackedProcesses);

  const app = Fastify();registerExtraRoutes(app);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const server = new McpServer({ name: "audit39-jobs", version: "1" });
  installDefaultToolOutputContracts(server);registerJobTools(server, new AgentClient([{ name: "fixture", url, userUrl: url }]));
  const client = new Client({ name: "fixture", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: "job_lineage", arguments: { device: "fixture", id, identity: "owner", offset: 550, limit: 20 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ id, offset: 550, nextOffset: 559, hasMore: false, identity: "owner", context: "user", items: trackedProcesses.slice(550) });
    const invalid = await app.inject({ method: "POST", url: "/v1/jobs/lineage", payload: { id, limit: 257 } });
    expect(invalid.statusCode).toBe(400);
    const status = await client.callTool({ name: "job_status", arguments: { device: "fixture", id } });
    expect(status.structuredContent).toMatchObject(flags);
    expect(status.structuredContent).not.toHaveProperty("trackedProcesses");
  } finally { await client.close();await server.close();await app.close(); }
});
