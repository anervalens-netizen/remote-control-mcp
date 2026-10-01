import Fastify from "fastify";
import { it, expect, vi } from "vitest";
vi.mock("../apps/agent/src/search.ts", () => ({ search: vi.fn(async (_input, signal: AbortSignal) => { signal.throwIfAborted(); return []; }) }));
import { search } from "../apps/agent/src/search.ts";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
it("observes a disconnect which happened before search listener registration", async () => {
  const app = Fastify();
  app.addHook("preHandler", async request => { Object.defineProperty(request.raw, "aborted", { value: true }); });
  registerExtraRoutes(app);
  try {
    await app.inject({ method: "POST", url: "/v1/search", payload: { path: ".", pattern: "fixture" } });
    expect(vi.mocked(search).mock.calls[0]?.[1]?.aborted).toBe(true);
  } finally { await app.close(); }
});
