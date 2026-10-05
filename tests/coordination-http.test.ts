import { nativeCommand } from "../apps/agent/src/shell-quote.ts";
import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { createMcpHttpServer } from "../apps/mcp-server/src/http-server.ts";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });
function repo() {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "repo-"));
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(path.join(root, "file.txt"), "before\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=Synthetic", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "fixture"]);
  return root;
}
async function harness() {
  const agent = Fastify(); registerExtraRoutes(agent);
  agent.get("/v1/info", async () => ({ runtime: { capabilities: ["high-level-coordination-v1", "high-level-idempotency-v1", "job-key-recovery-v1", "utf8-byte-pages-v1"] } }));
  const url = await agent.listen({ host: "127.0.0.1", port: 0 }); close.push(() => agent.close());
  const http = createMcpHttpServer(new AgentClient([{ name: "fixture", url, userUrl: url }]), { token: "fixture-token" });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  close.push(async () => { http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); });
  async function connect() {
    const client = new Client({ name: "fixture", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer fixture-token" } } });
    await client.connect(transport); close.push(async () => { await transport.terminateSession(); await client.close(); });
    await client.listTools();
    return (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { device: "fixture", ...args } });
  }
  return { a: await connect(), b: await connect(), agent, base };
}
it("two SDK sessions fence canonical aliases, changed bases and stale tokens before a real patch", async () => {
  const root = repo(), { a, b } = await harness();
  mkdirSync(path.join(root, "sub"));
  const resource = { kind: "repo", path: root };
  const first = await a("resource_coordination", { action: "acquire", resource });
  expect(first.isError, JSON.stringify(first)).not.toBe(true);
  const token = (first.structuredContent as any).token;
  const conflict = await b("resource_coordination", { action: "acquire", resource: { kind: "repo", path: path.join(root, "sub") } });
  expect(conflict.isError).toBe(true); expect(conflict.structuredContent).toMatchObject({ coordinationConflict: { reason: "writer_reserved", coordination: { operationId: (token as any).operationId, generation: 1 } } });
  const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n";
  writeFileSync(path.join(root, "file.txt"), "external\n");
  const stale = await a("repo_apply_patch", { path: root, patch, coordination: token });
  expect(stale.isError).toBe(true); expect(JSON.stringify(stale)).toContain("base_changed");
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("external\n");
  await a("resource_coordination", { action: "release", resource, token });
  writeFileSync(path.join(root, "file.txt"), "before\n");
  const next = await b("resource_coordination", { action: "acquire", resource });
  const applied = await b("repo_apply_patch", { path: root, patch, coordination: (next.structuredContent as any).token });
  expect(applied.isError).not.toBe(true); expect(readFileSync(path.join(root, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("after\n");
  const replay = await a("repo_apply_patch", { path: root, patch, coordination: token });
  expect(replay.isError).toBe(true); expect(JSON.stringify(replay)).toContain("stale_writer");
}, 15_000);
it("canonicalizes symlinks and detects same-size edits in repository base", async () => {
  const root = repo(), alias = root + "-alias"; symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  const first = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(await resolveCoordinationResource({ kind: "repo", path: alias })).toEqual(first);
  writeFileSync(path.join(root, "file.txt"), "edited\n");
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).not.toBe(first.baseVersion);
});
it("linked worktrees of a synthetic repository share the common Git resource", async () => {
  const root = repo(), linked = root + "-linked";
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", linked]);
  const first = await resolveCoordinationResource({ kind: "repo", path: root });
  const second = await resolveCoordinationResource({ kind: "repo", path: linked });
  expect(second.canonicalKey).toBe(first.canonicalKey);
  const { ResourceCoordinator, coordinationToken } = await import("../apps/agent/src/coordination.ts");
  const c = new ResourceCoordinator(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "linked-coord-")));
  const token = coordinationToken(c.acquire(first));
  expect(() => c.acquire(second)).toThrow("writer_reserved");
  c.release(token);
  expect(c.acquire(second).generation).toBe(2);
});

it("repo reservations fence deployments and keyed recovery preserves the original job after base changes", async () => {
  const root = repo(), { a, b } = await harness(), resource = { kind: "repo", path: root };
  const first = await a("resource_coordination", { action: "acquire", resource });
  expect(first.isError).not.toBe(true);
  const input = { repoPath: root, apply: "exit 0", idempotencyKey: "deployment-key", identity: "owner" };
  const blocked = await b("deploy_run", input);
  expect(blocked.isError).toBe(true);
  expect(blocked.structuredContent).toMatchObject({ coordinationConflict: { reason: "writer_reserved" } });
  const started = await a("deploy_run", { ...input, coordination: (first.structuredContent as any).token });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  const id = (started.structuredContent as any).job.id;
  const finished = await b("job_wait", { id, identity: "owner", waitMs: 3000 });
  expect(finished.structuredContent).toMatchObject({ terminal: true, exitCode: 0 });
  writeFileSync(path.join(root, "file.txt"), "changed after deployment\n");
  const recovered = await b("deploy_run", input);
  expect(recovered.isError).not.toBe(true);
  expect(recovered.structuredContent).toMatchObject({ job: { id } });
  const collision = await b("deploy_run", { ...input, apply: "exit 7" });
  expect(collision.isError).toBe(true);
  expect(JSON.stringify(collision)).toContain("job_start_conflict");
  const next = await b("resource_coordination", { action: "acquire", resource });
  expect(next.isError).not.toBe(true);
  await b("resource_coordination", { action: "release", resource, token: (next.structuredContent as any).token });
});
it("durable jobs keep the resource across keys while reads, health and cancel remain responsive", async () => {
  const root = repo(), { a, b, base } = await harness();
  const command = nativeCommand([process.execPath, "-e", "setTimeout(()=>{},30000)"]);
  const start = await a("project_run", { path: root, command, idempotencyKey: "first-key" });
  expect(start.isError).not.toBe(true);
  const id = ((start.structuredContent as any).result as any).id;
  const conflict = await b("project_run", { path: root, command, idempotencyKey: "different-key" });
  expect(conflict.isError).toBe(true); expect(JSON.stringify(conflict)).toContain("active_or_uncertain_writer");
  const before = performance.now();
  const [status, health, cancel] = await Promise.all([
    b("job_status", { id, identity: "owner" }), fetch(base + "/health"), b("job_cancel", { id, identity: "owner" }),
  ]);
  expect(status.isError).not.toBe(true); expect(health.status).toBe(200); expect(cancel.isError).not.toBe(true);
  expect(performance.now() - before).toBeLessThan(2000);
  const recovered = await b("project_run", { path: root, command, idempotencyKey: "first-key" });
  expect(recovered.isError).not.toBe(true); expect(((recovered.structuredContent as any).result as any).id).toBe(id);
}, 10000);

it("unsupported raw dryRun does not bypass a reserved patch fence or change patch execution", async () => {
  const root = repo(), agent = Fastify(); registerExtraRoutes(agent); close.push(() => agent.close());
  const resource = { kind: "repo", path: root };
  const reservation = await agent.inject({ method: "POST", url: "/v1/coordination", payload: { action: "acquire", resource } });
  expect(reservation.statusCode).toBe(200);
  const patch = "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-before\n+after\n";
  const payload = { path: root, patch, dryRun: true };
  const blocked = await agent.inject({ method: "POST", url: "/v1/repo/apply-patch", payload });
  expect(blocked.statusCode).toBe(409); expect(blocked.json().details.reason).toBe("writer_reserved");
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
  const check = await agent.inject({ method: "POST", url: "/v1/repo/apply-patch", payload: { ...payload, checkOnly: true } });
  expect(check.statusCode).toBe(200);
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("before\n");
  const applied = await agent.inject({ method: "POST", url: "/v1/repo/apply-patch", payload: { ...payload, coordination: reservation.json().token } });
  expect(applied.statusCode).toBe(200);
  expect(applied.json().coordination.state).toBe("released");
  expect(readFileSync(path.join(root, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("after\n");
});

it("symbolic HEAD and detached HEAD invalidate tokens even at the same commit", async () => {
  const root = repo();
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("branch", "synthetic-one"); git("branch", "synthetic-two");
  git("symbolic-ref", "HEAD", "refs/heads/synthetic-one");
  const first = await resolveCoordinationResource({ kind: "repo", path: root });
  const { ResourceCoordinator, coordinationToken } = await import("../apps/agent/src/coordination.ts");
  const c = new ResourceCoordinator(mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "head-coord-")));
  const token = coordinationToken(c.acquire(first));
  const commit = git("rev-parse", "HEAD"), refs = git("show-ref", "--head"), index = git("ls-files", "--stage");
  git("symbolic-ref", "HEAD", "refs/heads/synthetic-two");
  const second = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(second.canonicalKey).toBe(first.canonicalKey);
  expect(second.baseVersion).not.toBe(first.baseVersion);
  expect(() => c.begin(token, second)).toThrow("base_changed");
  // Change only HEAD, leaving refs, index and working file metadata untouched.
  git("update-ref", "--no-deref", "HEAD", commit);
  const detached = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(detached.baseVersion).not.toBe(first.baseVersion);
  expect(detached.baseVersion).not.toBe(second.baseVersion);
  expect(() => c.begin(token, detached)).toThrow("base_changed");
  expect(git("rev-parse", "HEAD")).toBe(commit);
  expect(git("show-ref", "--head")).toBe(refs); expect(git("ls-files", "--stage")).toBe(index);
  git("symbolic-ref", "HEAD", "refs/heads/synthetic-one");
  expect((await resolveCoordinationResource({ kind: "repo", path: root })).baseVersion).toBe(first.baseVersion);
});
