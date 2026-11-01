import type { FastifyInstance } from "fastify";
import { semanticActSchema, semanticObserveSchema } from "../../../packages/protocol/src/semantic-desktop.ts";
import { desktopRequest } from "./desktop-sequence.ts";
import { semanticDesktop, type SemanticDesktop } from "./semantic-desktop.ts";

export function registerSemanticDesktopRoutes(app: FastifyInstance, backend: SemanticDesktop = semanticDesktop) {
  app.post("/v1/desktop/observe", desktopRequest(async (request, reply) => {
    const parsed = semanticObserveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return backend.observe(parsed.data);
  }));
  app.post("/v1/desktop/act", desktopRequest(async (request, reply) => {
    const parsed = semanticActSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    return backend.act(parsed.data);
  }));
}
