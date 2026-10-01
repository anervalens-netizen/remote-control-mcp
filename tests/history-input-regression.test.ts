import Fastify from "fastify";
import { it, expect } from "vitest";
import { registerExtraRoutes } from "../apps/agent/src/extra-routes.ts";
it("returns HTTP 400 for malformed opaque history cursors before loading receipts", async () => {
  const app = Fastify(); registerExtraRoutes(app);
  try {
    for (const cursor of ["not-json", Buffer.from('{}').toString('base64url'), Buffer.from('[]').toString('base64url'), Buffer.from('{"id":"x","startedAt":5}').toString('base64url')]) {
      const response = await app.inject({ method: "GET", url: `/v1/jobs/history?cursor=${cursor}` });
      expect(response.statusCode).toBe(400);
    }
  } finally { await app.close(); }
});
