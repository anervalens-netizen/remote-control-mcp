import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentClient } from "./agent-client.ts";
import { resolveExecutionContext } from "./execution-identity.ts";

/** This is a client of an operator-installed, owner-local gateway, not a new GitHub subscription manager. */
const pr = z.string().max(256).regex(/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/)
  .refine(value => !/[\r\n]/.test(value) && !/\/\.{1,2}\/pull\//.test(value), "Use a canonical GitHub PR URL");
const device = z.string().min(1);
const after = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0);
const limit = z.number().int().min(1).max(100).default(20);
const outputSchema = z.object({
  device: z.string(),
  timedOut: z.boolean(),
  data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const eventArgs = (cursor: number, count: number, resource?: string) =>
  ["--after", String(cursor), "--limit", String(count), ...(resource ? ["--pr", resource] : [])];
const MAX_BYTES = 48 * 1024;
async function invoke(client: AgentClient, name: string, args: string[], signal: AbortSignal | undefined, waitSeconds?: number) {
  // An explicit owner-only endpoint is required. Do not fall back to root or accept arbitrary shell commands.
  const target = resolveExecutionContext(client, name, { identity: "owner", elevation: "never" }, "user");
  const command = '"$HOME/.local/bin/github-event-gateway" ' + args.map(quote).join(" ");
  const receipt = await client.exec(name, {
    command, timeoutMs: waitSeconds === undefined ? 12_000 : (waitSeconds + 5) * 1000, maxOutputBytes: MAX_BYTES,
  }, target, { signal });
  if (receipt.timedOut || receipt.signal || receipt.stdoutTruncated || receipt.cancelled || receipt.cancellationRequested || receipt.drainTimedOut || ("controllerStdoutTruncated" in receipt && receipt.controllerStdoutTruncated === true) || ("agentStdoutTruncated" in receipt && receipt.agentStdoutTruncated === true))
    throw new Error("Gateway output incomplete; inspect service health or request fewer events.");
  const timedOut = args[0] === "wait" && receipt.code === 8;
  if (!timedOut && receipt.code !== 0) throw new Error("Gateway command failed (exit " + receipt.code + "). Inspect the owner-local gateway service.");
  let data: unknown;
  try { data = JSON.parse(receipt.stdout); } catch { throw new Error("Gateway did not return valid JSON."); }
  const structured = outputSchema.parse({ device: name, timedOut, data });
  if (timedOut && (!Array.isArray(structured.data) || structured.data.length !== 0)) throw new Error("Unexpected gateway timeout response.");
  return { structuredContent: structured, content: [{ type: "text" as const, text: JSON.stringify(structured) }] };
}
export function registerGithubEventTools(server: McpServer, client: AgentClient) {
  server.registerTool("github_event_status", {
    description: "Read health, connected streams, reconciliation and journal cursor from an owner-local GitHub Event Streams gateway installed on a Linux device. No GitHub API polling or token access.",
    inputSchema: { device }, outputSchema, annotations: readonly,
  }, ({ device }, extra) => invoke(client, device, ["status"], extra.signal));
  server.registerTool("github_pr_snapshot", {
    description: "Read the cached reconciled state of a GitHub PR, including head SHA, reviews and checks. Not a merge or required-checks verdict.",
    inputSchema: { device, pr }, outputSchema, annotations: readonly,
  }, ({ device, pr }, extra) => invoke(client, device, ["snapshot", pr], extra.signal));
  server.registerTool("github_pr_events", {
    description: "Read retained PR events after a gateway-local cursor. A reconciled observation is not a delivered GitHub event. Retention and reconnect gaps require authoritative re-read.",
    inputSchema: { device, pr: pr.optional(), after, limit }, outputSchema, annotations: readonly,
  }, ({ device, pr, after, limit }, extra) => invoke(client, device, ["events", ...eventArgs(after, limit, pr)], extra.signal));
  server.registerTool("github_pr_wait", {
    description: "Wait up to 45 seconds on the local event journal, without GitHub polling. Normal empty timeout is not a failure. Re-read authoritative current-head state before decisions.",
    inputSchema: { device, pr: pr.optional(), after, limit, timeoutSeconds: z.number().int().min(1).max(45).default(20) },
    outputSchema, annotations: readonly,
  }, ({ device, pr, after, limit, timeoutSeconds }, extra) => invoke(client, device, ["wait", ...eventArgs(after, limit, pr), "--timeout", String(timeoutSeconds)], extra.signal, timeoutSeconds));
  server.registerTool("github_pr_track", {
    description: "Request tracking of a PR through the existing owner-local GitHub Event Streams gateway, without editing the PR. May allocate a GitHub event subscription. Reuse the shared gateway; do not create parallel subscriptions.",
    inputSchema: { device, pr }, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ device, pr }, extra) => invoke(client, device, ["track", pr], extra.signal));
}

