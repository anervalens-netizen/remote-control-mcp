import { measureSync } from "../../../packages/protocol/src/diagnostic-context.ts";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
export const reconciliationEvidenceSchema = z.strictObject({
  projectId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid(),
  jobId: z.string().min(1).max(200), revision: z.number().int().positive(),
  status: z.enum(["completed", "failed", "cancelled", "lost"]), verification: z.enum(["pending", "passed", "failed"]),
  evidenceRecordId: z.string().uuid(), journalSha256: hash,
});
const diagnosticFields = {
  totalRetries: z.number().int().nonnegative().optional(),
  totalAttempts: z.number().int().nonnegative().optional(), lastAttemptAt: z.number().nonnegative().optional(),
  remoteEvidence: reconciliationEvidenceSchema.omit({ evidenceRecordId: true, journalSha256: true }).optional(),
};
const historicalResolution = z.strictObject({
  reason: z.literal("retrospective_verification"),
  resolvedAt: z.string().datetime(),
  evidenceRecordId: z.string().uuid(),
  originalRecordSha256: hash,
  evidence: reconciliationEvidenceSchema.optional(),
});
const v1 = z.strictObject({ version: z.literal(1), ...baseFields, state: activeState });
const v2 = z.strictObject({
  version: z.literal(2), ...baseFields, ...diagnosticFields, state: activeState, attachAcknowledged: z.boolean(),
  createdAt: z.number().finite().nonnegative(), attempts: z.number().int().nonnegative().max(30),
  nextAttemptAt: z.number().finite().nonnegative(), lastError: z.enum(errorCategories).optional(),
});
const v3 = z.strictObject({
  version: z.literal(3), ...baseFields, ...diagnosticFields,
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
function syncDirectory(directory: string) {
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function rawRegularFile(file: string, synchronize = false) {
  let fd: number | undefined;
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error();
    const raw = readFileSync(fd);
    if (synchronize) fsyncSync(fd);
    return { raw, stat };
  } catch { throw new BridgeError("journal"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function rawEntry(directory: string, key: string) {
  return rawRegularFile(journalFile(directory, key));
}
function syncDirectoryAncestry(directory: string): void {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    syncDirectory(current);
    if (path.dirname(current) === current) return;
  }
}
function parseEntry(raw: Buffer, mtimeMs: number, key: string): Entry {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    const parsed = z.union([v1, v2, v3]).parse(value);
    if (parsed.key !== key || (parsed.state !== "job_start_uncertain" && !parsed.jobId) ||
        (parsed.state === "job_start_uncertain" && (parsed.jobId || parsed.observed))) throw new Error();
    if (parsed.version !== 1 && parsed.state === "delivered" && !parsed.attachAcknowledged) throw new Error();
    if (parsed.version === 3) {
      if ((parsed.state === "historical_resolved") !== Boolean(parsed.historicalResolution)) throw new Error();
      if (parsed.state === "historical_resolved" && parsed.attachAcknowledged) throw new Error();
    }
    const entry: Entry = parsed.version === 1 ? {
      ...parsed, version: 2, attachAcknowledged: false, createdAt: Math.max(0, mtimeMs), attempts: 0, nextAttemptAt: 0,
    } : parsed;
    if (entry.attachAcknowledged && !entry.jobId) throw new Error();
    return entry;
  } catch { throw new BridgeError("journal"); }
}
export function readEntry(directory: string, key: string): Entry {
  const { raw, stat } = rawEntry(directory, key);
  return parseEntry(raw, stat.mtimeMs, key);
}
function withEntryLock<T>(directory: string, key: string, action: () => T): T {
  journalFile(directory, key); // Validate before constructing the lock path.
  const file = path.join(directory, key + ".lock");
  let fd: number | undefined;
  try {
    try { fd = openSync(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BridgeError("journal");
      throw error;
    }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fsyncSync(fd);
    syncDirectory(directory);
    return action();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try { unlinkSync(file); syncDirectory(directory); }
      catch { /* A stale lock fails closed until inspected. */ }
    }
  }
}
function saveEntryUnlocked(directory: string, entry: Entry, create = false): void {
  const file = journalFile(directory, entry.key), temporary = file + "." + randomUUID() + ".tmp";
  const fd = openSync(create ? file : temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(entry)); fsyncSync(fd); }
  finally { closeSync(fd); }
  if (!create) renameSync(temporary, file);
  syncDirectory(directory);
}
export function saveEntry(directory: string, entry: Entry, create = false): void {
  return measureSync("persistence", () => withEntryLock(directory, entry.key, () => {
    if (!create && readEntry(directory, entry.key).state === "historical_resolved") throw new BridgeError("journal");
    saveEntryUnlocked(directory, entry, create);
  }));
}

export function historicallyResolveEntry(directory: string, recoveryDirectory: string, input: {
  key: string; expectedHash: string; expectedJobId: string; expectedRunId: string;
  evidenceRecordId: string; resolvedAt?: string;
  evidence: z.infer<typeof reconciliationEvidenceSchema>;
}): Entry {
  if (!path.isAbsolute(directory) || !path.isAbsolute(recoveryDirectory) ||
      path.resolve(directory) === path.resolve(recoveryDirectory)) throw new BridgeError("journal");
  return withEntryLock(directory, input.key, () => {
    const { raw, stat } = rawEntry(directory, input.key);
    const entry = parseEntry(raw, stat.mtimeMs, input.key);
    if (entry.state !== "tracking" || entry.attachAcknowledged || !entry.jobId ||
        entry.hash !== input.expectedHash || entry.jobId !== input.expectedJobId ||
        entry.correlation.runId !== input.expectedRunId) throw new BridgeError("journal");
    const originalRecordSha256 = createHash("sha256").update(raw).digest("hex");
    const evidence = reconciliationEvidenceSchema.parse(input.evidence);
    if (evidence.journalSha256 !== originalRecordSha256 || evidence.projectId !== entry.correlation.projectId ||
        evidence.taskId !== entry.correlation.taskId || evidence.runId !== entry.correlation.runId ||
        evidence.jobId !== entry.jobId || evidence.evidenceRecordId !== input.evidenceRecordId ||
        entry.observed && (evidence.status !== (entry.observed.state === "completed" ? (entry.observed.exitCode === 0 ? "completed" : "failed") : entry.observed.state)) ||
        entry.remoteEvidence && (evidence.revision < entry.remoteEvidence.revision || entry.remoteEvidence.verification === "failed" && evidence.verification !== "failed" ||
          ["failed", "lost"].includes(entry.remoteEvidence.status) && evidence.status !== entry.remoteEvidence.status)) throw new BridgeError("journal");
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    // Persist every ancestor link, including links left by a failed prior attempt.
    syncDirectoryAncestry(recoveryDirectory);
    const recoveryFile = path.join(recoveryDirectory, input.key + "." + originalRecordSha256 + ".before.json");
    try {
      const fd = openSync(recoveryFile, "wx", 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); }
      finally { closeSync(fd); }
      syncDirectory(recoveryDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
          createHash("sha256").update(rawRegularFile(recoveryFile, true).raw).digest("hex") !== originalRecordSha256)
        throw new BridgeError("journal");
    }
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    const proof = historicalResolution.parse({
      reason: "retrospective_verification", resolvedAt, evidenceRecordId: input.evidenceRecordId, originalRecordSha256, evidence,
    });
    const resolved: Entry = {
      ...entry, version: 3, state: "historical_resolved", attachAcknowledged: false,
      attempts: 0, nextAttemptAt: 0, lastError: undefined, historicalResolution: proof,
    };
    saveEntryUnlocked(directory, resolved);
    return resolved;
  });
}

/** Explicit offline reconciliation. Caller must fence all journal writers first.
 * The lock is archived, never discarded based on age or PID. A missing receipt
 * requires the original bounded receipt bytes from independently preserved evidence. */
export function reconcileOrphanLock(directory: string, recoveryDirectory: string, input: {
  key: string; expectedLockSha256: string; originalReceipt: string; writersFenced: true;
  evidence: z.infer<typeof reconciliationEvidenceSchema>;
}): Entry {
  if (input.writersFenced !== true || !path.isAbsolute(directory) || !path.isAbsolute(recoveryDirectory) || directory === recoveryDirectory) throw new BridgeError("journal");
  const file = journalFile(directory, input.key), lock = path.join(directory, input.key + ".lock");
  // Validate the entire evidence tuple before any mutation. No guessed receipt.
  const raw = Buffer.from(input.originalReceipt);
  if (raw.length > 64 * 1024) throw new BridgeError("journal");
  const entry = parseEntry(raw, 0, input.key), evidence = reconciliationEvidenceSchema.parse(input.evidence);
  const sha = createHash("sha256").update(raw).digest("hex");
  if (entry.state !== "tracking" || entry.attachAcknowledged || evidence.journalSha256 !== sha ||
      evidence.projectId !== entry.correlation.projectId || evidence.taskId !== entry.correlation.taskId ||
      evidence.runId !== entry.correlation.runId || evidence.jobId !== entry.jobId ||
      entry.observed && evidence.status !== (entry.observed.state === "completed" ? (entry.observed.exitCode === 0 ? "completed" : "failed") : entry.observed.state) ||
      entry.remoteEvidence && (evidence.revision < entry.remoteEvidence.revision || entry.remoteEvidence.verification === "failed" && evidence.verification !== "failed" ||
        ["failed", "lost"].includes(entry.remoteEvidence.status) && evidence.status !== entry.remoteEvidence.status)) throw new BridgeError("journal");
  let lockFd: number | undefined;
  try {
    lockFd = openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(lockFd);
    if (!stat.isFile() || stat.size > 4096) throw new BridgeError("journal");
    const lockBytes = readFileSync(lockFd);
    if (createHash("sha256").update(lockBytes).digest("hex") !== input.expectedLockSha256) throw new BridgeError("journal");
    // A present receipt must match the preserved evidence byte-for-byte.
    let present = false;
    try { lstatSync(file); present = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (present && !rawEntry(directory, input.key).raw.equals(raw)) throw new BridgeError("journal");
    // Exclusive reconciliation guard is itself fail-closed after a crash.
    const guard = path.join(directory, input.key + ".reconcile.lock");
    const guardFd = openSync(guard, "wx", 0o600);
    try {
      mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    // Persist every ancestor link, including links left by a failed prior attempt.
    syncDirectoryAncestry(recoveryDirectory);
      for (const [suffix, bytes] of [["receipt", raw], ["lock", lockBytes]] as const) {
        const backup = path.join(recoveryDirectory, `${input.key}.${sha}.${suffix}`);
        const fd = openSync(backup, "wx", 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      syncDirectory(recoveryDirectory);
      const resolved: Entry = { ...entry, version: 3, state: "historical_resolved", attachAcknowledged: false,
        historicalResolution: { reason: "retrospective_verification", resolvedAt: new Date().toISOString(), evidenceRecordId: evidence.evidenceRecordId, originalRecordSha256: sha, evidence } };
      saveEntryUnlocked(directory, resolved);
      closeSync(lockFd); lockFd = undefined;
      renameSync(lock, path.join(directory, input.key + ".resolved-lock." + input.expectedLockSha256));
      syncDirectory(directory);
      return resolved;
    } finally { closeSync(guardFd); unlinkSync(guard); syncDirectory(directory); }
  } finally { if (lockFd !== undefined) closeSync(lockFd); }
}
