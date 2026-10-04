import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerCoordinationRoutes } from "../apps/agent/src/coordination-routes.ts";
import { CoordinationError, coordinationHash, coordinationToken, ResourceCoordinator } from "../apps/agent/src/coordination.ts";
import { resolveCoordinationResource } from "../apps/agent/src/coordination-resource.ts";
vi.mock("../apps/agent/src/coordination-resource.ts", () => ({ resolveCoordinationResource: vi.fn() }));
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); vi.resetAllMocks(); vi.unstubAllEnvs(); });
function fixture() {
  const root = mkdtempSync(path.join(process.env.RCMCP_STATE_DIR!, "lifecycle-"));
  vi.stubEnv("RCMCP_COORDINATION_DIR", root);
  const app = Fastify(); close.push(() => app.close());
  const coordinate = registerCoordinationRoutes(app), coordinator = new ResourceCoordinator(root);
  const resource = { device: coordinationHash("device"), identity: coordinationHash("owner"), canonicalKey: coordinationHash("repo"), baseVersion: coordinationHash("base") };
  vi.mocked(resolveCoordinationResource).mockResolvedValue(resource);
  const request = { raw: { aborted: false } } as FastifyRequest;
  const replyState = { raw: { destroyed: false }, statusCode: 200, code(status: number) { replyState.statusCode = status; return replyState; }, send(value: unknown) { return value; } };
  const reply = replyState as unknown as FastifyReply;
  return { coordinate, coordinator, resource, request, reply };
}
it.each(["before_probe", "during_probe"])("cancellation %s releases a supplied reservation without effects", async when => {
  const f = fixture(), token = coordinationToken(f.coordinator.acquire(f.resource)), effect = vi.fn();
  if (when === "before_probe") Object.assign(f.request.raw, { aborted: true });
  else vi.mocked(resolveCoordinationResource).mockResolvedValueOnce(f.resource).mockImplementationOnce(async () => {
    Object.assign(f.reply.raw, { destroyed: true }); return f.resource;
  });
  const result = await f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", mode: "exec", coordination: token }, effect);
  expect(result).toMatchObject({ error: "coordination_conflict", details: { reason: "cancelled_before_apply" } });
  expect(effect).not.toHaveBeenCalled();
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("released");
  expect(f.coordinator.acquire(f.resource).generation).toBe(2);
});
it("a failed automatic revalidation releases its reservation without dispatch", async () => {
  const f = fixture(), effect = vi.fn();
  vi.mocked(resolveCoordinationResource).mockResolvedValueOnce(f.resource).mockRejectedValueOnce(new CoordinationError("base_probe_limit"));
  expect(await f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic" }, effect)).toMatchObject({ details: { reason: "base_probe_limit" } });
  expect(effect).not.toHaveBeenCalled();
  expect(f.coordinator.inspect(f.resource).record?.state).toBe("released");
});
it("an exception after begin remains uncertain and cannot be overridden or replayed", async () => {
  const f = fixture(), effect = vi.fn(async () => { throw new Error("effect receipt unavailable"); });
  await expect(f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", mode: "exec" }, effect)).rejects.toThrow("effect receipt unavailable");
  const record = f.coordinator.inspect(f.resource).record!;
  expect(record).toMatchObject({ state: "uncertain", conflictReason: "effect_or_termination_unverified" });
  expect(() => f.coordinator.acquire(f.resource, 1000, { expectedGeneration: record.generation, expectedBaseVersion: record.baseVersion, reason: "owner_takeover" })).toThrow("active_or_uncertain_writer");
  expect(await f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", mode: "exec" }, effect)).toMatchObject({ details: { reason: "active_or_uncertain_writer" } });
  expect(effect).toHaveBeenCalledTimes(1);
});

it("product no-effect proof settles only the exact begun token and cannot be reused", async () => {
  const { executionBoundary } = await import("../apps/agent/src/execution-boundary.ts");
  const f = fixture(), first = f.coordinator.acquire(f.resource), token = coordinationToken(first);
  const error = new Error("synthetic planning failure");
  await expect(f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", coordination: token },
    () => executionBoundary(async () => { throw error; }))).rejects.toBe(error);
  expect(f.coordinator.inspect(f.resource).record).toMatchObject({ ...token, state: "released" });
  const second = f.coordinator.acquire(f.resource), nextToken = coordinationToken(second);
  const noDispatch = vi.fn(() => executionBoundary(async () => { throw error; }));
  expect(await f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", coordination: token }, noDispatch)).toMatchObject({ details: { reason: "stale_writer" } });
  expect(noDispatch).not.toHaveBeenCalled();
  expect(f.coordinator.inspect(f.resource).record).toMatchObject({ ...nextToken, state: "reserved" });
  // An ordinary error in another invocation has no proof, even if the same
  // exception object previously came from an effect-free product preflight.
  await expect(f.coordinate("/v1/project/run", f.request, f.reply, { path: "synthetic", coordination: nextToken },
    async () => { throw error; })).rejects.toBe(error);
  expect(f.coordinator.inspect(f.resource).record).toMatchObject({ ...nextToken, state: "uncertain" });
});
