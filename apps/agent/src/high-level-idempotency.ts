import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JobStartKeyError } from "./job-start-dedup.ts";
import { ensureStateDir } from "./state.ts";

type Reservation = { version: 1; kind: string; fingerprint: string; value: unknown };
type Pending = { kind: string; fingerprint: string; promise: Promise<unknown> };
const root = ensureStateDir("high-level-keys");
const inFlight = new Map<string, Pending>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function fingerprint(intent: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(intent))).digest("hex");
}

function keyPath(idempotencyKey: string): string {
  if (!idempotencyKey.length || idempotencyKey.length > 200) {
    throw new Error("idempotencyKey must contain 1 to 200 characters");
  }
  return path.join(root, createHash("sha256").update(idempotencyKey).digest("hex") + ".json");
}

function parseReservation<T>(
  file: string,
  kind: string,
  digest: string,
  parseValue: (value: unknown) => T,
): { value: T; replayed: true } {
  let record: Reservation;
  try {
    record = JSON.parse(readFileSync(file, "utf8")) as Reservation;
    if (record.version !== 1 || typeof record.kind !== "string" || !/^[a-f0-9]{64}$/.test(record.fingerprint)) {
      throw new Error("Invalid high-level reservation");
    }
  } catch {
    throw new JobStartKeyError("job_start_uncertain");
  }
  if (record.kind !== kind || record.fingerprint !== digest) throw new JobStartKeyError("job_start_conflict");
  try {
    return { value: parseValue(record.value), replayed: true };
  } catch {
    throw new JobStartKeyError("job_start_uncertain");
  }
}

/**
 * Persist read-only derivation that must survive a keyed retry before the
 * durable job reservation is consulted. This never starts or replays work.
 */
export async function resolveHighLevelKey<T>(options: {
  kind: string;
  idempotencyKey: string;
  intent: unknown;
  create: () => T | Promise<T>;
  parseValue: (value: unknown) => T;
}): Promise<{ value: T; replayed: boolean }> {
  const { kind, idempotencyKey, intent, create, parseValue } = options;
  const file = keyPath(idempotencyKey);
  const digest = fingerprint(intent);
  const key = path.basename(file, ".json");
  const pending = inFlight.get(key);
  if (pending) {
    if (pending.kind !== kind || pending.fingerprint !== digest) throw new JobStartKeyError("job_start_conflict");
    const result = await pending.promise as { value: T; replayed: boolean };
    return { value: result.value, replayed: true };
  }

  const promise = Promise.resolve().then(async () => {
    // Planning/snapshotting is read-only. Publish the durable reservation only
    // after it succeeds so a crash in preflight cannot masquerade as an
    // uncertain effect.
    const value = await create();
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return parseReservation(file, kind, digest, parseValue);
    }
    try {
      const record: Reservation = { version: 1, kind, fingerprint: digest, value };
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch {}
      try { rmSync(file, { force: true }); } catch {}
      throw error;
    }
    closeSync(fd);
    if (process.platform !== "win32") {
      const directory = openSync(root, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { value, replayed: false };
  });

  inFlight.set(key, { kind, fingerprint: digest, promise });
  try {
    return await promise as { value: T; replayed: boolean };
  } finally {
    inFlight.delete(key);
  }
}
