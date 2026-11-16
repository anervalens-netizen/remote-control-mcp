import { z } from "zod";
import { coordinationTokenSchema } from "../../../packages/protocol/src/coordination.ts";

export const repoOperationSchema = z.enum(["fetch", "pull", "push"]);
export type RepoOperation = z.infer<typeof repoOperationSchema>;
export const repoOperationRequestSchema = z.object({
  version: z.literal(1), operation: repoOperationSchema, token: coordinationTokenSchema,
  device: z.string().regex(/^[a-f0-9]{64}$/), identity: z.string().regex(/^[a-f0-9]{64}$/), canonicalKey: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.object({
    path: z.string().min(1), remote: z.string().optional(), refspecs: z.array(z.string()).optional(),
    prune: z.boolean().optional(), tags: z.boolean().optional(), ffOnly: z.boolean().optional(),
    setUpstream: z.boolean().optional(), timeoutMs: z.number().int().positive().optional(),
  }).strict(),
}).strict();
export const repoOperationResultSchema = z.object({
  version: z.literal(1), requestHash: z.string().regex(/^[a-f0-9]{64}$/), ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(), error: z.string().max(40 * 1024).optional(),
}).strict();
