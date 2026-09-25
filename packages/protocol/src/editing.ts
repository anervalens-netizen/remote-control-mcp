import { z } from "zod";

export const repoCheckpointFields = {
  path: z.string().min(1), message: z.string().optional(),
  mode: z.enum(["all", "staged", "paths"]).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  includeUntracked: z.boolean().optional(), allowEmpty: z.boolean().optional(),
  dryRun: z.boolean().optional(),
};
export const repoPatchFields = {
  path: z.string().min(1), patch: z.string().min(1),
  target: z.enum(["worktree", "index", "both"]).optional(),
  checkOnly: z.boolean().optional(), reverse: z.boolean().optional(),
  strip: z.number().int().nonnegative().optional(),
  directory: z.string().min(1).optional(),
  whitespace: z.enum(["nowarn", "warn", "fix", "error", "error-all"]).optional(),
  unidiffZero: z.boolean().optional(),
};
export const fsEditFields = {
  path: z.string().min(1),
  edits: z.array(z.object({
    oldText: z.string().min(1), newText: z.string(),
    expectedOccurrences: z.number().int().positive().optional(),
  })).min(1),
  expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  dryRun: z.boolean().optional(),
};
export type RepoCheckpointInput = z.infer<z.ZodObject<typeof repoCheckpointFields>>;
export type RepoPatchInput = z.infer<z.ZodObject<typeof repoPatchFields>>;
export type FsEditInput = z.infer<z.ZodObject<typeof fsEditFields>>;
