import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
import { ResourceCoordinator, coordinationToken } from "../apps/agent/src/coordination.ts";
import * as state from "../apps/agent/src/state.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function directory(prefix: string) { return mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, prefix)); }
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }

/** A synthetic repository with an optional pre-commit hook. The hook content is
 * a fixture, never real project data or a real guard implementation. */
function repo(hook?: string) {
  const root = directory("hook-repo-");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Synthetic");
  git(root, "config", "user.email", "fixture@users.noreply.github.com");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "file.txt"), "synthetic\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  if (hook) writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), hook, { mode: 0o755 });
  return root;
}

function harness() {
  const journal = directory("hook-coordination-");
  vi.stubEnv("RCMCP_COORDINATION_DIR", journal);
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
  return { app, post, journal, coordinator: new ResourceCoordinator(journal) };
}

const guard = "#!/bin/sh\necho 'privacy guard: staged code rejected' >&2\nexit 42\n";

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("synthetic condition was not observed");
}

it("keeps a rejected commit fenced, publishes no success and never loses staged files", async () => {
  const root = repo(guard), unrelated = repo(), f = harness();
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");

  const failed = await f.post("/v1/repo/checkpoint", { path: root });
  expect(failed.statusCode, failed.body).toBe(500);
  const body = failed.json();
  // No published success for the rejected commit.
  expect(body).toMatchObject({ error: "repository_commit_failed", noReplay: true, evidencePublication: "available" });
  expect(body.ok).toBeUndefined();
  expect(body.created).toBeUndefined();
  expect(body.hookFailure).toMatchObject({
    version: 1, command: { boundary: "commit" },
    hook: { boundary: "unavailable", exitCode: 1, exitCodeSource: "command" },
    classification: "unverified", containment: { verified: false },
  });
  expect(body.hookFailure.hook.output).toBeUndefined();
  expect(body.hookFailure.refs.beforeHead).toBe(head);
  expect(body.hookFailure.refs.afterHead).toBe(head);
  expect(body.coordination).toMatchObject({ state: "uncertain", conflictReason: "effect_or_termination_unverified" });
  const token = body.coordination.token;

  // The rejected commit changed neither HEAD nor the staged files.
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "diff", "--cached", "--name-only")).toBe("file.txt");
  expect(readFileSync(path.join(root, "file.txt"), "utf8")).toBe("changed\n");

  // A second coordinated commit is refused while the writer is uncertain.
  const blocked = await f.post("/v1/repo/checkpoint", { path: root });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().details.reason).toBe("active_or_uncertain_writer");

  // An unrelated fresh worktree can still publish its own commit.
  writeFileSync(path.join(unrelated, "file.txt"), "unrelated\n");
  git(unrelated, "add", "file.txt");
  const published = await f.post("/v1/repo/checkpoint", { path: unrelated });
  expect(published.statusCode, published.body).toBe(200);
  expect(published.json()).toMatchObject({ created: true, head: git(unrelated, "rev-parse", "HEAD") });

  // A failed hook alone never releases the uncertain writer.
  const released = await f.post("/v1/coordination", { action: "release", resource: { kind: "repo", path: root }, token });
  expect(released.statusCode).toBe(409);
  expect(released.json().details.reason).toBe("active_or_uncertain_writer");
}, 20_000);

it("retains the original fence on repeated inspection and reconciliation requests", async () => {
  const root = repo(guard), f = harness();
  const head = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  const failed = await f.post("/v1/repo/checkpoint", { path: root });
  expect(failed.statusCode, failed.body).toBe(500);
  const token = failed.json().coordination.token;
  const current = await resolveCoordinationResource({ kind: "repo", path: root });
  const original = f.coordinator.inspectRecovery(current);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.post("/v1/coordination", {
      action: "reconcile", resource: { kind: "repo", path: root }, token, expectedCurrentBaseVersion: current.baseVersion,
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().details.reason).toBe("hook_failure_effect_unverified");
    expect(f.coordinator.inspectRecovery(current)).toEqual(original);
  }
  expect(original.record?.state).toBe("uncertain");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(git(root, "diff", "--cached", "--name-only")).toBe("file.txt");
}, 20_000);

it("retains the rejected commit evidence when the transport disconnects mid-operation", async () => {
  const root = repo("#!/bin/sh\nsleep 0.4\necho 'privacy guard: staged code rejected' >&2\nexit 1\n"), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  const base = await resolveCoordinationResource({ kind: "repo", path: root });
  const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = Number(new URL(address).port);
  const request = http.request({ host: "127.0.0.1", port, path: "/v1/repo/checkpoint", method: "POST", headers: { "content-type": "application/json" } });
  request.on("error", () => undefined);
  request.end(JSON.stringify({ path: root }));
  // Disconnect only after the writer began, so the rejected commit is in flight.
  await until(() => f.coordinator.current(base)?.state === "active");
  request.destroy();
  await until(() => f.coordinator.current(base)?.state === "uncertain");
  const record = f.coordinator.current(base)!;
  const token = coordinationToken(record);
  const failure = f.coordinator.hookFailure(token);
  expect(failure?.failure).toMatchObject({ hook: { boundary: "unavailable", exitCodeSource: "command" }, classification: "unverified" });
  const current = await resolveCoordinationResource({ kind: "repo", path: root });
  const reconciled = await f.post("/v1/coordination", {
    action: "reconcile", resource: { kind: "repo", path: root }, token, expectedCurrentBaseVersion: current.baseVersion,
  });
  expect(reconciled.statusCode, reconciled.body).toBe(409);
  expect(f.coordinator.inspect(current).record?.state).toBe("uncertain");
}, 20_000);

it.each([
  ["touches the worktree", "#!/bin/sh\necho 'guard touched the worktree' >> file.txt\nexit 1\n", "partially_applied"],
  ["spawns a descendant", "#!/bin/sh\nsleep 0.4 &\necho 'guard spawned a descendant' >&2\nexit 1\n", "unverified"],
])("keeps the writer fenced when a hook %s", async (_case, hook, classification) => {
  const root = repo(hook), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  const failed = await f.post("/v1/repo/checkpoint", { path: root });
  expect(failed.statusCode, failed.body).toBe(500);
  expect(failed.json().hookFailure.classification).toBe(classification);
  const token = failed.json().coordination.token;
  const current = await resolveCoordinationResource({ kind: "repo", path: root });
  const reconciled = await f.post("/v1/coordination", {
    action: "reconcile", resource: { kind: "repo", path: root }, token, expectedCurrentBaseVersion: current.baseVersion,
  });
  expect(reconciled.statusCode, reconciled.body).toBe(409);
  expect(reconciled.json().details.reason).toBe("hook_failure_effect_unverified");
  expect(f.coordinator.inspect(current).record?.state).toBe("uncertain");
  expect(() => f.coordinator.acquire(current)).toThrow("active_or_uncertain_writer");
}, 20_000);

it("keeps the fence when the evidence cannot be published", async () => {
  const root = repo(guard), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  const atomic = state.atomicWriteJson;
  const write = vi.spyOn(state, "atomicWriteJson").mockImplementation((file, value, mode) => {
    if (file.includes(path.sep + "hook-failures" + path.sep)) throw new Error("synthetic evidence publication failure");
    atomic(file, value, mode);
  });
  const failed = await f.post("/v1/repo/checkpoint", { path: root });
  write.mockRestore();
  expect(failed.statusCode, failed.body).toBe(500);
  expect(failed.json()).toMatchObject({ noReplay: true, evidencePublication: "unavailable" });
  const token = failed.json().coordination.token;
  const current = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(f.coordinator.hookFailure(token)).toBeNull();
  const result = await f.post("/v1/coordination", {
    action: "reconcile", resource: { kind: "repo", path: root }, token, expectedCurrentBaseVersion: current.baseVersion,
  });
  expect(result.statusCode).toBe(409);
  expect(f.coordinator.inspect(current).record?.state).toBe("uncertain");
}, 20_000);

it("keeps matching status snapshots from implying unchanged file content", async () => {
  const root = repo("#!/bin/sh\nprintf 'updated fixture\\n' > draft.txt\nexit 1\n"), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  writeFileSync(path.join(root, "draft.txt"), "initial fixture\n");
  git(root, "add", "file.txt");
  const status = git(root, "status", "--porcelain=v2");
  const rejected = await f.post("/v1/repo/checkpoint", { path: root });
  expect(rejected.statusCode, rejected.body).toBe(500);
  expect(git(root, "status", "--porcelain=v2")).toBe(status);
  expect(readFileSync(path.join(root, "draft.txt"), "utf8")).toBe("updated fixture\n");
  const failure = rejected.json().hookFailure;
  expect(failure.classification, JSON.stringify(failure)).toBe("unverified");
  expect(failure.worktree.before).toMatch(/^[0-9a-f]{64}$/);
  expect(failure.worktree).toMatchObject({ after: failure.worktree.before, changed: null });
}, 20_000);

it("marks observations beyond the output budget unavailable", async () => {
  const root = repo(guard), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  for (let file = 0; file < 1300; file++) {
    writeFileSync(path.join(root, `fixture-${file}-${"x".repeat(210)}.txt`), "");
  }
  const rejected = await f.post("/v1/repo/checkpoint", { path: root });
  expect(rejected.statusCode, rejected.body).toBe(500);
  expect(rejected.json().hookFailure).toMatchObject({
    classification: "unverified", worktree: { before: null, after: null, changed: null },
  });
}, 20_000);

it("refuses a stale or foreign token for the rejected commit", async () => {
  const root = repo(guard), f = harness();
  writeFileSync(path.join(root, "file.txt"), "changed\n");
  git(root, "add", "file.txt");
  const failed = await f.post("/v1/repo/checkpoint", { path: root });
  const token = failed.json().coordination.token;
  const current = await resolveCoordinationResource({ kind: "repo", path: root });
  for (const wrong of [{ ...token, generation: token.generation + 1 }, { ...token, operationId: randomUUID() },
    { ...token, resourceId: token.resourceId.replace(/^./, (c: string) => (c === "a" ? "b" : "a")) }]) {
    const refused = await f.post("/v1/coordination", {
      action: "reconcile", resource: { kind: "repo", path: root }, token: wrong, expectedCurrentBaseVersion: current.baseVersion,
    });
    expect(refused.statusCode).toBe(409);
  }
  expect(f.coordinator.inspect(current).record?.state).toBe("uncertain");
}, 20_000);
