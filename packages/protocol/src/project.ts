import { z } from "zod";
import { timeoutMsField } from "./deadline.ts";
export const projectFields = {
  path: z.string().min(1), action: z.enum(["install", "check", "test", "build", "typecheck", "lint", "script"]).optional(),
  stack: z.enum(["auto", "node", "python", "go", "rust", "dotnet", "make"]).optional(),
  manager: z.string().min(1).optional(), script: z.string().min(1).optional(),
  command: z.string().min(1).describe("Raw shell command; args use shell parsing. Use executable for literal native argv.").optional(), executable: z.string().min(1).describe("Run any native executable directly with literal args; bypasses manifest detection.").optional(), args: z.array(z.string()).optional(),
};
export const projectRunFields = {
  ...projectFields, mode: z.enum(["exec", "job"]).optional(), dryRun: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: timeoutMsField.describe("Synchronous exec timeout; 0 disables it. Durable jobs use job_cancel.").optional(),
  maxOutputBytes: z.number().int().positive().max(64 * 1024 * 1024).describe("Synchronous exec output budget; durable jobs retain paginated logs.").optional(),
};
export type ProjectRunInput = z.infer<z.ZodObject<typeof projectRunFields>>;
export type ProjectInput = z.infer<z.ZodObject<typeof projectFields>>;
export const deployFields = {
  command: z.string().min(1).optional(), cwd: z.string().optional(), repoPath: z.string().optional(),
  prepare: z.string().min(1).optional(), apply: z.string().min(1).optional(),
  verify: z.string().min(1).optional(), recover: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(), dryRun: z.boolean().optional(),
};
export type DeployInput = z.infer<z.ZodObject<typeof deployFields>>;
export const jobFollowFields = {
  id: z.string().min(1),
  cursor: z.object({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() }).optional(),
  waitMs: z.number().int().nonnegative().max(2_147_483_647).optional(),
  until: z.enum(["complete", "output"]).optional(),
  maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
};
export type JobFollowInput = z.infer<z.ZodObject<typeof jobFollowFields>>;

export const jobLineageFields = {
  id: z.string().min(1), offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(256).optional(),
};
export const jobLineageSchema = z.object(jobLineageFields);
export const jobLineageResultSchema = z.object({
  id: z.string(), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), hasMore: z.boolean(),
  // Opaque native identities: do not assume Linux formatting on Windows.
  items: z.array(z.object({pid: z.number().int().positive(), identity: z.string()})).max(256),
});
