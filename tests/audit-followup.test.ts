import { withJobDiagnostics } from "../apps/mcp-server/src/job-diagnostics.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContextKeepBridge, jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { OperationObserver, operationsFor } from "../apps/mcp-server/src/operation-observer.ts";
import { registerTools } from "../apps/mcp-server/src/all-tools.ts";
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); vi.useRealTimers(); });
function directory() { const root = mkdtempSync(path.join(tmpdir(), "audit-followup-")); closers.push(() => rmSync(root, { recursive: true, force: true })); return root; }
it("parks missing terminal attach proof across restart without replay, preserving a failed verification", async () => {
  const root = directory(), scope = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() };
  const client = { jobStart: vi.fn(async () => ({ id: "synthetic-job" })), jobStatus: vi.fn(async () => ({ id: "synthetic-job", state: "completed" })) };
  const run = { id: scope.runId, projectId: scope.projectId, taskId: scope.taskId, externalJobId: "synthetic-job", device: "fixture", identity: "owner", revision: 4, status: "completed", verification: "failed" };
  const call = vi.fn(async (name: string) => {
    if (name === "attach_run_job") throw new Error("stale lease");
    return { task: { id: scope.taskId }, runs: [run], pagination: { offset: 0, limit: 50, totalRuns: 1 } };
  });
  const make = () => { const b = new ContextKeepBridge(client as unknown as AgentClient, { directory: root, url: "http://127.0.0.1/mcp", token: "fixture" }, call); closers.push(() => b.close()); return b; };
  const bridge = make(), input = { command: "synthetic", idempotencyKey: "one-intent" };
  await bridge.start("fixture", "user", input, scope); await bridge.pump();
  const file = path.join(root, readdirSync(root).find(name => name.endsWith(".json"))!);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "reconciliation_required", attachAcknowledged: false, nextAttemptAt: 0, remoteEvidence: { verification: "failed" } });
  expect(bridge.diagnostics()).toMatchObject({ pendingCount: 1, retryingCount: 0, reconciliationRequiredCount: 1 });
  const before = readFileSync(file, "utf8"); const restarted = make();
  await restarted.pump(); await restarted.pump();
  await restarted.start("fixture", "user", input, scope);
  expect(call).toHaveBeenCalledTimes(2); expect(client.jobStart).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, "utf8")).toBe(before);
});
it("reports capacity gaps and persists bounded daily totals without storing result payloads", async () => {
  const root = directory(), observer = new OperationObserver(root, 1);
  const first = (await observer.begin("read", undefined))!;
  await observer.finish(first, { ok: true }, true, false);
  const second = (await observer.begin("read", undefined))!;
  await observer.finish(second, { error: { code: "capture_permission_required", message: "private-message" } }, false, false);
  const view = await observer.health();
  expect(view).toMatchObject({ partial: true, historyHasGaps: true, counters: { evicted: 1 }, dailySummary: [{ started: 2, succeeded: 1, failed: 1 }] });
  expect(await observer.inspect(second)).toMatchObject({ failure: { kind: "domain_error", agentCode: "capture_permission_required" } });
  expect(JSON.stringify(view)).not.toContain("private-message");
  const restored = new OperationObserver(root, 1);
  expect(await restored.health()).toMatchObject({ historyHasGaps: true, dailySummary: [{ started: 2, succeeded: 1, failed: 1 }] });
});
it("associates correlated jobs with their task while preserving explicit scopes", async () => {
  const observer = new OperationObserver(), work = { projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID() };
  const id = (await observer.begin("job_start", undefined, undefined, undefined, work))!;
  expect(await observer.inspect(id)).toMatchObject({ diagnosticScopeId: work.taskId, associationSource: "contextkeep_task" });
  const explicit = randomUUID(), other = (await observer.begin("job_start", explicit, undefined, undefined, work))!;
  expect(await observer.inspect(other)).toMatchObject({ diagnosticScopeId: explicit, associationSource: "explicit" });
});
it("opens global history and prepares exactly the bridge input hash without executor access", async () => {
  const agent = new AgentClient([]), server = new McpServer({ name: "synthetic", version: "1" });
  registerTools(server, agent); const client = new Client({ name: "synthetic", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(async () => { await client.close(); await server.close(); });
  const observer = operationsFor(agent), id = (await observer.begin("synthetic", undefined))!;
  await observer.finish(id, {}, true, false);
  const opened = await client.callTool({ name: "open_remote_control_console", arguments: {} });
  expect(opened.isError).not.toBe(true);
  expect(opened.structuredContent).toMatchObject({ operations: { items: [{ traceId: id }] }, suggestedDiagnosticScopeId: expect.any(String) });
  expect(opened.structuredContent).not.toHaveProperty("diagnosticScopeId");
  const input = { command: "synthetic", cwd: "/fixture", env: { "2": "two", "10": "ten" } };
  const hashed = await client.callTool({ name: "job_input_hash", arguments: input });
  expect(hashed.isError).not.toBe(true);
  expect(hashed.structuredContent).toMatchObject({ inputHash: jobInputHash(input), startsExecution: false });
});

it("flags long-running jobs without changing execution state or terminal history", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");
  const running = { id: "fixture", state: "running", startedAt: "2026-01-01T00:00:00Z" };
  expect(withJobDiagnostics(running, now)).toMatchObject({ state: "running", lifecycleDiagnostics: { reviewRecommended: true, elapsedMs: 86_400_000 } });
  expect(withJobDiagnostics({ ...running, state: "completed" }, now)).not.toHaveProperty("lifecycleDiagnostics");
  expect(withJobDiagnostics({ ...running, startedAt: "invalid" }, now)).not.toHaveProperty("lifecycleDiagnostics");
  expect(withJobDiagnostics({ items: [running] }, now).items[0]).toHaveProperty("lifecycleDiagnostics");
});
