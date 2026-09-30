import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ContextKeepBridge } from "../apps/mcp-server/src/contextkeep-bridge.ts";
import type { AgentClient } from "../apps/mcp-server/src/agent-client.ts";

const scope = () => ({ projectId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), leaseToken: randomUUID() });
const client = { jobStart: async () => ({ id: "synthetic-job" }), jobStatus: async () => ({ id: "synthetic-job", state: "completed", exitCode: 0, finishedAt: "2026-01-01T00:00:00.000Z" }) } as unknown as AgentClient;
for (const kind of ["empty", "wrong-id", "valid-text-json", "valid-sse"]) {
  it(`checks actual ACKs over loopback: ${kind}`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-regression-"));
    const work = scope();
    const run = { id: work.runId, projectId: work.projectId, taskId: work.taskId, externalJobId: "synthetic-job", device: "fixture", identity: "owner", revision: 2, status: "running", verification: "pending" };
    const server = createServer(async (req, res) => {
      const buffers = []; for await (const chunk of req) buffers.push(chunk);
      const rpc = JSON.parse(Buffer.concat(buffers).toString("utf8"));
      let value: unknown = { run };
      if (rpc.params.name === "get_task") value = { task: { id: work.taskId }, runs: [run], pagination: { totalRuns: 1, offset: 0, limit: 50 } };
      if (rpc.params.name === "observe_run") { run.status = "completed"; value = { run, duplicate: false, applied: true, observationId: randomUUID() }; }
      const body = JSON.stringify(kind === "empty" ? {} : { jsonrpc: "2.0", id: kind === "wrong-id" ? "unrelated" : rpc.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
      if (kind === "valid-sse") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${body}\n\n`); }
      else res.writeHead(200, { "content-type": "application/json" }).end(body);
    });
    let bridge: ContextKeepBridge | undefined;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address() as { port: number };
      bridge = new ContextKeepBridge(client, { directory, url: `http://127.0.0.1:${address.port}/mcp`, token: "synthetic" });
      await bridge.start("fixture", "user", { command: "fixture", idempotencyKey: "one" }, work);
      await bridge.pump();
      expect(JSON.parse(readFileSync(path.join(directory, readdirSync(directory)[0]!), "utf8")).state).toBe(kind.startsWith("valid") ? "delivered" : "tracking");
    } finally {
      await bridge?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
it("isolates a corrupt journal before a healthy journal", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bridge-regression-"));
  const bridge = new ContextKeepBridge(client, { directory, url: "http://127.0.0.1/mcp", token: "synthetic" }, async () => ({}));
  try {
    writeFileSync(path.join(directory, "0".repeat(64) + ".json"), "{");
    await bridge.start("fixture", "user", { command: "fixture", idempotencyKey: "one" }, scope());
    await expect(bridge.pump()).resolves.toBeUndefined();
  } finally { await bridge.close(); rmSync(directory, { recursive: true, force: true }); }
});
