import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BridgeError, errorCategories } from "./contextkeep-transport.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const correlationSchema = z.strictObject({ projectId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid(), leaseToken: z.string().uuid() });
export type WorkCorrelation = z.infer<typeof correlationSchema>;
export const observationSchema = z.strictObject({ state: z.enum(["completed", "cancelled", "lost"]), exitCode: z.number().int().nullable(), finishedAt: z.string().datetime() });
const fields = {
  key: hash, hash, device: z.string().min(1).max(100), target: z.enum(["user", "system", "desktop"]),
  correlation: correlationSchema, state: z.enum(["job_start_uncertain", "tracking", "delivered"]),
  jobId: z.string().min(1).max(200).optional(), observed: observationSchema.optional(),
  attachKey: z.string().uuid(), observeKey: z.string().uuid(),
};
const v1 = z.strictObject({ version: z.literal(1), ...fields });
const v2 = z.strictObject({
  version: z.literal(2), ...fields, attachAcknowledged: z.boolean(),
  createdAt: z.number().finite().nonnegative(), attempts: z.number().int().nonnegative().max(30),
  nextAttemptAt: z.number().finite().nonnegative(), lastError: z.enum(errorCategories).optional(),
});
export type Entry = z.infer<typeof v2>;
export function journalFile(directory: string, key: string): string {
  if (!hash.safeParse(key).success) throw new BridgeError("journal");
  return path.join(directory, key + ".json");
}
export function readEntry(directory: string, key: string): Entry {
  let fd: number | undefined;
  try {
    const file = journalFile(directory, key);
    if (lstatSync(file).isSymbolicLink()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const parsed = z.union([v1, v2]).parse(value);
    if (parsed.key !== key || (parsed.state !== "job_start_uncertain" && !parsed.jobId) ||
        (parsed.state === "job_start_uncertain" && (parsed.jobId || parsed.observed))) throw new Error();
    const entry: Entry = parsed.version === 2 ? parsed : {
      ...parsed, version: 2, attachAcknowledged: false, createdAt: Math.max(0, stat.mtimeMs), attempts: 0, nextAttemptAt: 0,
    };
    if (entry.attachAcknowledged && !entry.jobId) throw new Error();
    return entry;
  } catch { throw new BridgeError("journal"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function saveEntry(directory: string, entry: Entry, create = false): void {
  const file = journalFile(directory, entry.key), temporary = file + "." + randomUUID() + ".tmp";
  const fd = openSync(create ? file : temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (!create) renameSync(temporary, file);
  // Reservation is exclusive and durable before execution. Failed/partial files
  // are evidence of uncertainty; never delete them to make a start retryable.
  if (process.platform !== "win32") {
    const dir = openSync(directory, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
}
