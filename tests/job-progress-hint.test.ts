import { afterEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { withActionableJobProgress } from "../apps/mcp-server/src/job-progress-hint.ts";
import { registerJobTools } from "../apps/mcp-server/src/job-tools.ts";

afterEach(() => vi.restoreAllMocks());

const now = Date.parse("2026-11-18T14:00:00.000Z");
it("reports a running wait expiry as ongoing work, without a hang or terminal result", () => {
  const raw = { id: "synthetic-job", state: "running", waitExpired: true, stdoutBytes: 12, stderrBytes: 0,
    retryAfterMs: 750, startedAt: "2026-11-18T13:59:00Z" };
  const hint = withActionableJobProgress(raw, now) as typeof raw & { progressGuidance: Record<string, unknown> };
  expect(hint.progressGuidance).toMatchObject({
    state: "running", terminalRecordObserved: false, waitExpiredWithoutTermination: true,
    inputWaitEvidence: "unverified", effectVerification: "unknown", completionPercent: null,
    nextCheck: "job_wait", retryAfterMs: 750, useOriginalJobId: true,
    outputBytes: { stdout: 12, stderr: 0 }, observedAt: "2026-11-18T14:00:00.000Z",
  });
  expect(raw).not.toHaveProperty("progressGuidance");
});

it("preserves cancellation intent separately from verified termination", () => {
  const cancelling = withActionableJobProgress({ id: "job-a", state: "cancelling",
    terminationVerified: false }, now) as any;
  expect(cancelling.progressGuidance).toMatchObject({
    cancellationRequested: true, terminationEvidence: "unverified",
    terminalRecordObserved: false, nextCheck: "job_wait",
  });
  const cancelled = withActionableJobProgress({ id: "job-b", state: "cancelled",
    terminationVerified: false }, now) as any;
  expect(cancelled.progressGuidance).toMatchObject({
    cancellationRequested: true, terminationEvidence: "unverified",
    terminalRecordObserved: true, nextCheck: "job_lineage",
  });
  const verified = withActionableJobProgress({ id: "job-c", state: "cancelled",
    terminationVerified: true }, now) as any;
  expect(verified.progressGuidance).toMatchObject({
    terminationEvidence: "verified", nextCheck: "job_output_since",
  });
});

it("does not equate successful process exit, missing metadata or lost jobs with independently verified effects", () => {
  const done = withActionableJobProgress({ id: "job", state: "completed", exitCode: 0 }, now) as any;
  expect(done.progressGuidance).toMatchObject({
    state: "completed", terminalRecordObserved: true, effectVerification: "unknown",
    inputWaitEvidence: "unverified", completionPercent: null, nextCheck: "job_output_since",
  });
  const lost = withActionableJobProgress({ id: "job", state: "lost" }, now) as any;
  expect(lost.progressGuidance.nextCheck).toBe("job_lineage");
  expect(lost.progressGuidance.terminationEvidence).toBe("unknown");
  expect(withActionableJobProgress({ state: "not_found" })).toEqual({ state: "not_found" });
});

it("enriches a keyed durable resolution without changing its receipt or redispatching its start", () => {
  const response = { state: "resolved", jobId: "job", fingerprint: "opaque",
    job: { id: "job", state: "running", stdoutBytes: 5 } };
  const wrapped = withActionableJobProgress(response, now) as any;
  expect(wrapped).toMatchObject({ state: "resolved", jobId: "job", fingerprint: "opaque",
    job: { state: "running", progressGuidance: { nextCheck: "job_wait", outputBytes: { stdout: 5 } } } });
  expect(response.job).not.toHaveProperty("progressGuidance");
});

it("publishes the same compact guidance in the real MCP job_status and wait result envelopes", async () => {
  const agent = new AgentClient([{ name: "fixture", url: "http://127.0.0.1:1" }]);
  vi.spyOn(agent, "jobStatus").mockResolvedValue({ id: "synthetic-job", state: "running", stdoutBytes: 1 });
  vi.spyOn(agent, "jobStatusByKey").mockResolvedValue({
    state: "resolved", jobId: "synthetic-job", job: { id: "synthetic-job", state: "running", stdoutBytes: 1 },
  });
  vi.spyOn(agent, "jobFollow").mockResolvedValue({
    id: "synthetic-job", state: "running", stdoutBytes: 1, stderrBytes: 0,
    terminal: false, waitExpired: true, cursor: { stdout: 0, stderr: 0 },
    stdout: { nextOffset: 0, eof: false, data: "" },
    stderr: { nextOffset: 0, eof: true, data: "" },
    outputComplete: false,
  });
  const server = new McpServer({ name: "synthetic-jobs", version: "1" });
  registerJobTools(server, agent);
  const sdk = new Client({ name: "synthetic-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), sdk.connect(b)]);
    for (const args of [
      { device: "fixture", identity: "root", id: "synthetic-job" },
      { device: "fixture", identity: "root", idempotencyKey: "synthetic-key" },
    ]) {
      const result = await sdk.callTool({ name: "job_status", arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const structured = result.structuredContent as any;
      const job = structured.job ?? structured;
      expect(job.progressGuidance).toMatchObject({ state: "running", effectVerification: "unknown", nextCheck: "job_wait" });
      const legacy = JSON.parse(((result.content as Array<{ text: string }>)[0]!).text);
      expect(legacy.job?.progressGuidance ?? legacy.progressGuidance).toMatchObject({ nextCheck: "job_wait" });
    }
    const reply = await sdk.callTool({ name: "job_wait", arguments: {
      device: "fixture", identity: "root", id: "synthetic-job", waitMs: 250,
    } });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(reply.structuredContent).toMatchObject({
      state: "running", waitExpired: true,
      progressGuidance: { waitExpiredWithoutTermination: true, terminalRecordObserved: false,
        nextCheck: "job_wait", retryAfterMs: 750, completionPercent: null },
    });
  } finally { await sdk.close(); await server.close(); }
});
