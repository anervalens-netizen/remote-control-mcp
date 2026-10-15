import type { FastifyReply } from "fastify";
/** Expected read failures are domain outcomes, not agent crashes. This wrapper
 * is deliberately not used for mutations: status never proves absence of effects. */
export async function filesystemReadResponse<T>(run: () => Promise<T>, reply: FastifyReply) {
  try { return await run(); }
  catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const statuses: Record<string, number> = { ENOENT: 404, ENOTDIR: 400, EISDIR: 400, EACCES: 403, EPERM: 403 };
    if (typeof code === "string" && Object.hasOwn(statuses, code)) {
      return reply.code(statuses[code]!).send({ error: "filesystem_read_failed", code });
    }
    throw error;
  }
}
