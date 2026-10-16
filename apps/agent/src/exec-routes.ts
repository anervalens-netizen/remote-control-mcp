import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { execRequestFields } from "../../../packages/protocol/src/execution.ts";
import { runCommand } from "./exec.ts";
import type { ExecReceiptStore } from "./exec-receipts.ts";

export function registerExecRoutes(app: FastifyInstance, receipts: ExecReceiptStore) {
  app.post("/v1/exec/prepare", async () => receipts.prepare());
  app.post("/v1/exec/recover", async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(1).max(12 * 1024).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    return receipts.read(parsed.data.id, parsed.data.offset, parsed.data.length);
  });
  app.post("/v1/exec", async (request, reply) => {
    const parsed = z.object(execRequestFields).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Exec caller disconnected; foreground command cancelled"));
    const disconnected = () => { if (!reply.raw.writableFinished) abort(); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", disconnected);
    try {
      const { execReceiptId, ...input } = parsed.data;
      const run = () => runCommand(input, controller.signal);
      return execReceiptId ? await receipts.execute(execReceiptId, run) : await run();
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", disconnected);
    }
  });
}
