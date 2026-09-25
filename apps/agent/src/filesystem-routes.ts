import type { FastifyInstance } from "fastify";
import { fsManageSchema } from "../../../packages/protocol/src/filesystem.ts";
import { createDeadline } from "../../../packages/protocol/src/deadline.ts";
import { fsManage } from "./filesystem.ts";

export function registerFilesystemManageRoute(app: FastifyInstance): void {
  app.post("/v1/fs/manage", async (request, reply) => {
    const parsed = fsManageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableFinished) controller.abort(); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const deadline = createDeadline(parsed.data.timeoutMs, controller.signal);
    try { return await fsManage(parsed.data, deadline.signal); }
    finally {
      deadline.dispose(); request.raw.off("aborted", abort); reply.raw.off("close", abort);
    }
  });
}
