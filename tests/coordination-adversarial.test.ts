import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
import { coordinationDevice, coordinationHash, coordinationIdentity, coordinationToken, ResourceCoordinator } from "../apps/agent/src/coordination.ts";
import { jobCoordinationStatus, jobRemove, jobStartKeyStatus, jobStatusAsync } from "../apps/agent/src/jobs.ts";
import { executionBoundary, noEffectSubmittedProof, withExecutionProof } from "../apps/agent/src/execution-boundary.ts";

const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.unstubAllEnvs(); });
function directory(prefix: string) { return mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, prefix)); }
function git(root: string, ...args: string[]) { return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(); }
function repo() {
  const root = directory("adversarial-repo-");
  git(root, "init", "-q");
  writeFileSync(path.join(root, "file.txt"), "synthetic\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Synthetic", "-c", "user.email=fixture@users.noreply.github.com", "commit", "-qm", "fixture");
  return root;
}
function harness() {
  const journal = directory("adversarial-coordination-");
  vi.stubEnv("RCMCP_COORDINATION_DIR", journal);
  const app = Fastify(); registerExtraRoutes(app); close.push(() => app.close());
  const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
  return { app, post, journal, coordinator: new ResourceCoordinator(journal) };
}
async function completed(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await jobStatusAsync(id);
    if (status.state !== "running") { expect(status.state).toBe("completed"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic job did not complete");
}

it.each([false, true])("invalid project plan then corrected run releases only its reservation (supplied=%s)", async supplied => {
  const root = repo(), f = harness(), resource = { kind: "repo" as const, path: root };
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { check: "exit 0" } }));
  const base = await resolveCoordinationResource(resource);
  const token = supplied ? coordinationToken(f.coordinator.acquire(base)) : undefined;
  const failed = await f.post("/v1/project/run", { path: root, action: "script", script: "missing", coordination: token });
  expect(failed.statusCode).toBe(500); expect(failed.json().message).toContain("not found");
  const record = f.coordinator.inspect(base).record!;
  expect(record).toMatchObject({ state: "released", baseVersion: base.baseVersion, generation: 1 });
  if (token) expect(coordinationToken(record)).toEqual(token);
  const next = await f.post("/v1/project/run", { path: root, command: "exit 0", mode: "exec" });
  expect(next.statusCode).toBe(200);
  expect(next.json()).toMatchObject({ ok: true, coordination: { state: "released", generation: 2 } });
});

it.each(["validation", "preflight"])("deployment %s errors do not poison the next write", async failure => {
  const root = failure === "preflight" ? directory("not-a-repository-") : repo(), f = harness();
  const payload = failure === "preflight" ? { repoPath: root, apply: "exit 0" } : { cwd: root, apply: "exit 0", command: "exit 0" };
  const failed = await f.post("/v1/deploy/run", payload);
  expect(failed.statusCode).toBe(500);
  const base = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(f.coordinator.inspect(base).record?.state).toBe("released");
  const next = await f.post("/v1/deploy/run", { cwd: root, apply: "exit 0" });
  expect(next.statusCode).toBe(200);
  expect(next.json().coordination.generation).toBe(2);
  await completed(next.json().job.id);
});

it.each(["parse", "probe"])("repository %s errors before mutation leave no active fence", async failure => {
  const root = failure === "probe" ? directory("not-a-repository-") : repo(), f = harness();
  const failed = await f.post(failure === "parse" ? "/v1/repo/pull" : "/v1/repo/checkpoint",
    failure === "parse" ? { path: root, refspecs: ["main"] } : { path: root });
  expect(failed.statusCode).toBe(500);
  const base = await resolveCoordinationResource({ kind: "repo", path: root });
  expect(f.coordinator.inspect(base).record?.state).toBe("released");
  expect((await f.post("/v1/project/run", { path: root, command: "exit 0", mode: "exec" })).statusCode).toBe(200);
});

it("nested no-effect evidence never clears an earlier submission, and preserves typed errors", async () => {
  const error = Object.assign(new Error("synthetic"), { code: "synthetic_validation" });
  const scope = Symbol();
  await expect(withExecutionProof(scope, () => executionBoundary(async () => { throw error; }))).rejects.toBe(error);
  expect(noEffectSubmittedProof(error, scope)).toEqual({ effectSubmitted: false, invocation: scope });
  expect(noEffectSubmittedProof(error, Symbol())).toBeUndefined();
  await expect(withExecutionProof(scope, () => executionBoundary(async submit => {
    submit(); return executionBoundary(async () => { throw error; });
  }))).rejects.toBe(error);
  expect(noEffectSubmittedProof(error, scope)).toBeUndefined();
});

it("completed job removal preserves settlement and no-replay evidence across a process restart", async () => {
  const root = repo(), f = harness(), key = randomUUID();
  const started = await f.post("/v1/project/run", { path: root, command: "exit 0", idempotencyKey: key });
  expect(started.statusCode).toBe(200);
  const { result: job, coordination } = started.json();
  await completed(job.id);
  expect(f.coordinator.inspect(await resolveCoordinationResource({ kind: "repo", path: root })).record?.state).toBe("active");
  expect((await f.post("/v1/jobs/remove", { id: job.id })).statusCode).toBe(200);
  expect(existsSync(path.join(process.env.RCMCP_STATE_DIR!, "jobs", job.id + ".json"))).toBe(false);
  const script = `
import Fastify from 'fastify';
import {registerExtraRoutes} from ${JSON.stringify(new URL("../apps/agent/src/extra-routes.ts", import.meta.url).href)};
const app=Fastify();registerExtraRoutes(app);
const result=await app.inject({method:'POST',url:'/v1/project/run',payload:{path:process.argv[1],command:'exit 0',mode:'exec'}});
process.stdout.write(JSON.stringify({status:result.statusCode,body:result.json()}));await app.close();`;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, root], { encoding: "utf8", env: process.env }));
  expect(restarted).toMatchObject({ status: 200, body: { ok: true, coordination: { generation: coordination.generation + 1, state: "released" } } });
  expect((await jobStartKeyStatus(key)).state).not.toBe("not_found");
  const replay = await f.post("/v1/project/run", { path: root, command: "exit 0", idempotencyKey: key });
  expect(replay.statusCode).toBe(409); expect(replay.json().error).toBe("job_start_uncertain");
});

it("lost and missing job evidence remains fenced; wrong identity/resource/token cannot settle", async () => {
  const root = repo(), f = harness(), base = await resolveCoordinationResource({ kind: "repo", path: root });
  const record = f.coordinator.acquire(base), token = coordinationToken(record), id = randomUUID();
  f.coordinator.begin(token, base); f.coordinator.settle(token, { jobId: id });
  const evidence = { id, device: coordinationDevice, identity: coordinationIdentity, state: "completed" as const };
  for (const wrong of [{ ...evidence, id: randomUUID() }, { ...evidence, identity: coordinationHash("other") }, { ...evidence, device: coordinationHash("other") }]) {
    expect(() => f.coordinator.settle(token, { jobEvidence: wrong })).toThrow("job_evidence_mismatch");
  }
  expect(() => f.coordinator.settle({ ...token, baseVersion: coordinationHash("other") }, { jobEvidence: evidence })).toThrow("stale_writer");
  const otherBase = { ...base, canonicalKey: coordinationHash("other-resource") }, other = f.coordinator.acquire(otherBase);
  f.coordinator.begin(coordinationToken(other), otherBase); f.coordinator.settle(coordinationToken(other), { jobId: randomUUID() });
  expect(() => f.coordinator.settle(coordinationToken(other), { jobEvidence: evidence })).toThrow("job_evidence_mismatch");
  expect((await f.post("/v1/project/run", { path: root, command: "exit 0", mode: "exec" })).json().details.reason).toBe("active_or_uncertain_writer");
  // Synthetic terminal metadata: no process or business effect is created.
  writeFileSync(path.join(process.env.RCMCP_STATE_DIR!, "jobs", id + ".json"), JSON.stringify({
    id, command: "synthetic", cwd: root, pid: 0, state: "lost", startedAt: new Date().toISOString(),
    stdoutPath: "synthetic", stderrPath: "synthetic", exitPath: "synthetic",
  }));
  await jobRemove(id);
  expect(await jobCoordinationStatus(id)).toMatchObject({ id, state: "lost" });
  expect((await f.post("/v1/project/run", { path: root, command: "exit 0", mode: "exec" })).json().details.reason).toBe("active_or_uncertain_writer");
  expect(new ResourceCoordinator(f.journal).inspect(base).record?.state).toBe("uncertain");
});

it("bare repository refs and bounded metadata invalidate the base without worktree scans", async () => {
  const source = repo(), bare = directory("bare-repository-");
  git(bare, "clone", "--bare", "-q", source, ".");
  const ref = "refs/heads/synthetic-topic", head = git(bare, "rev-parse", "HEAD"), tree = git(bare, "rev-parse", "HEAD^{tree}");
  const secondCommit = git(bare, "-c", "user.name=Synthetic", "-c", "user.email=fixture@users.noreply.github.com", "commit-tree", tree, "-p", "HEAD", "-m", "second");
  git(bare, "update-ref", ref, head);
  // Create all objects and the loose branch before observing the base: the only
  // later change is one existing ref, not HEAD or an objects-directory timestamp.
  const first = await resolveCoordinationResource({ kind: "repo", path: bare });
  const f = harness(), token = coordinationToken(f.coordinator.acquire(first));
  git(bare, "update-ref", ref, secondCommit);
  expect(git(bare, "rev-parse", "HEAD")).toBe(head);
  const next = await resolveCoordinationResource({ kind: "repo", path: bare });
  expect(next.canonicalKey).toBe(first.canonicalKey); expect(next.baseVersion).not.toBe(first.baseVersion);
  expect(() => f.coordinator.begin(token, next)).toThrow("base_changed");
  expect((await resolveCoordinationResource({ kind: "repo", path: path.join(bare, "objects") })).canonicalKey).toBe(first.canonicalKey);
  const config = path.join(bare, "config"); writeFileSync(config, readFileSync(config, "utf8") + "\n# synthetic change\n");
  expect((await resolveCoordinationResource({ kind: "repo", path: bare })).baseVersion).not.toBe(next.baseVersion);
});
