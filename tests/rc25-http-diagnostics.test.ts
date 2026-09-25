import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { AgentClient, AgentRequestError } from "../apps/mcp-server/src/agent-client.ts";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function responseError(body: unknown, status = 500) {
  const app = Fastify(); apps.push(app);
  app.post("/v1/jobs/start", async (_, reply) => reply.code(status).send(body));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new AgentClient([{ name: "fixture", url }]);
  try { await client.jobStart("fixture", { command: "unused" }); }
  catch (error) { expect(error).toBeInstanceOf(AgentRequestError); return error as AgentRequestError; }
  throw new Error("The HTTP fixture unexpectedly succeeded");
}

it("preserves missing-job diagnostics instead of only HTTP status", async () => {
  const error = await responseError({ error: "Internal Server Error", code: "ENOENT", message: "Unknown job rc25-missing-fixture" });
  expect(error.message).toContain("ENOENT");
  expect(error.message).toContain("rc25-missing-fixture");
  expect(error.recovery).toBeUndefined();
});
it("preserves structured validation details without copying unrelated body fields", async () => {
  const error = await responseError({ error: "invalid_request", details: [{ path: ["command"], code: "invalid_type", message: "Expected string" }], credential: "fixture-secret" }, 400);
  expect(error.message).toContain("invalid_request");
  expect(error.message).toContain("command");
  expect(error.message).toContain("Expected string");
  expect(error.message).not.toContain("fixture-secret");
});
it("preserves ordinary non-JSON gateway diagnostics", async () => {
  const error = await responseError("Upstream agent connection refused", 502);
  expect(error.message).toContain("Upstream agent connection refused");
  expect(error.status).toBe(502);
});
it("bounds diagnostics and reports truncation without inventing recovery", async () => {
  const error = await responseError({ message: "large diagnostic " + "x".repeat(100_000) });
  expect(error.message).toContain("large diagnostic");
  expect(Buffer.byteLength(error.message)).toBeLessThan(9000);
  expect(error.responseBodyTruncated).toBe(true);
  expect(error.recovery).toBeUndefined();
});
it("redacts named credentials inside recognized diagnostics", async () => {
  const error = await responseError({ error: "invalid_request", details: { message: "configuration rejected", password: "nested-secret", accessToken: "nested-token", path: "settings" } });
  expect(error.message).toContain("configuration rejected");
  expect(error.message).toContain("settings");
  expect(error.message).not.toContain("nested-secret");
  expect(error.message).not.toContain("nested-token");
});
it("does not fall back to raw JSON when a parsed diagnostic exceeds formatting depth", async () => {
  const body = '{"credential":"deep-fixture-secret","details":' + '{"message":'.repeat(20_000) + '"too deep"' + '}'.repeat(20_000) + '}';
  const error = await responseError(body);
  expect(error.message).not.toContain("deep-fixture-secret");
  expect(error.responseBodyTruncated).toBe(true);
  expect(Buffer.byteLength(error.message)).toBeLessThan(9000);
});
