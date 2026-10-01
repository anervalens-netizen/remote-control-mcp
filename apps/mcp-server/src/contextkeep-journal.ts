import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { BridgeError, errorCategories } from "./contextkeep-transport.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const correlationSchema = z.strictObject({ projectId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid(), leaseToken: z.string().uuid() });
export type WorkCorrelation = z.infer<typeof correlationSchema>;
export const observationSchema = z.strictObject({ state: z.enum(["completed", "cancelled", "lost"]), exitCode: z.number().int().nullable(), finishedAt: z.string().datetime() });
const baseFields = {
  key: hash, hash, device: z.string().min(1).max(100), target: z.enum(["user", "system", "desktop"]),
  correlation: correlationSchema,
  jobId: z.string().min(1).max(200).optional(), observed: observationSchema.optional(),
  attachKey: z.string().uuid(), observeKey: z.string().uuid(),
};
const activeState = z.enum(["job_start_uncertain", "tracking", "delivered"]);
const historicalResolution = z.strictObject({
  reason: z.literal("retrospective_verification"),
  resolvedAt: z.string().datetime(),
  evidenceRecordId: z.string().uuid(),
  originalRecordSha256: hash,
});
const v1 = z.strictObject({ version: z.literal(1), ...baseFields, state: activeState });
const v2 = z.strictObject({
  version: z.literal(2), ...baseFields, state: activeState, attachAcknowledged: z.boolean(),
  createdAt: z.number().finite().nonnegative(), attempts: z.number().int().nonnegative().max(30),
  nextAttemptAt: z.number().finite().nonnegative(), lastError: z.enum(errorCategories).optional(),
});
const v3 = z.strictObject({
  version: z.literal(3), ...baseFields,
  state: z.enum(["job_start_uncertain", "tracking", "delivered", "historical_resolved"]),
  attachAcknowledged: z.boolean(),
  createdAt: z.number().finite().nonnegative(), attempts: z.number().int().nonnegative().max(30),
  nextAttemptAt: z.number().finite().nonnegative(), lastError: z.enum(errorCategories).optional(),
  historicalResolution: historicalResolution.optional(),
});
export type Entry = z.infer<typeof v2> | z.infer<typeof v3>;
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
    const parsed = z.union([v1, v2, v3]).parse(value);
    if (parsed.key !== key || (parsed.state !== "job_start_uncertain" && !parsed.jobId) ||
        (parsed.state === "job_start_uncertain" && (parsed.jobId || parsed.observed))) throw new Error();
    // Legacy v1 delivery is retained as a historical no-replay tombstone, but
    // v2/v3 delivered entries explicitly require durable hash-checked attachment proof.
    if (parsed.version !== 1 && parsed.state === "delivered" && !parsed.attachAcknowledged) throw new Error();
    if (parsed.version === 3) {
      if ((parsed.state === "historical_resolved") !== Boolean(parsed.historicalResolution)) throw new Error();
      if (parsed.state === "historical_resolved" && parsed.attachAcknowledged) throw new Error();
    }
    const entry: Entry = parsed.version === 1 ? {
      ...parsed, version: 2, attachAcknowledged: false, createdAt: Math.max(0, stat.mtimeMs), attempts: 0, nextAttemptAt: 0,
    } : parsed;
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


export function historicallyResolveEntry(directory: string, input: {
  key: string; expectedHash: string; expectedJobId: string; expectedRunId: string;
  evidenceRecordId: string; resolvedAt?: string;
}): Entry {
  const file = journalFile(directory, input.key);
  const original = readFileSync(file);
  const entry = readEntry(directory, input.key);
  if (entry.state !== "tracking" || entry.attachAcknowledged || !entry.jobId ||
      entry.hash !== input.expectedHash || entry.jobId !== input.expectedJobId ||
      entry.correlation.runId !== input.expectedRunId) throw new BridgeError("journal");
  const resolvedAt = input.resolvedAt ?? new Date().toISOString();
  const proof = historicalResolution.parse({
    reason: "retrospective_verification", resolvedAt, evidenceRecordId: input.evidenceRecordId,
    originalRecordSha256: createHash("sha256").update(original).digest("hex"),
  });
  const resolved: Entry = {
    ...entry, version: 3, state: "historical_resolved", attachAcknowledged: false,
    attempts: 0, nextAttemptAt: 0, lastError: undefined, historicalResolution: proof,
  };
  saveEntry(directory, resolved);
  return resolved;
}
