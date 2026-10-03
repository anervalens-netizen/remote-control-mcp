import { jobSummarySchema } from "../../../packages/protocol/src/job-summary.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { statSync } from "node:fs";

type Entry = { id: string; startedAt: string; state: string; stamp: string };
export type HistoryQuery = { limit?: number; cursor?: string; state?: string };
const compare = (a: Pick<Entry, "startedAt" | "id">, b: Pick<Entry, "startedAt" | "id">) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
export class HistoryCursorError extends Error {
  readonly statusCode = 400;
  constructor() { super("Invalid job history cursor"); this.name = "HistoryCursorError"; }
}
export function decodeHistoryCursor(value?: string): Pick<Entry, "startedAt" | "id"> | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HistoryCursorError();
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new HistoryCursorError(); }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new HistoryCursorError();
  const object = cursor as Record<string, unknown>;
  if (typeof object.id !== "string" || !object.id || typeof object.startedAt !== "string" || !object.startedAt) throw new HistoryCursorError();
  return { id: object.id, startedAt: object.startedAt };
}
/** Rebuildable process-local index. JSON receipts remain the authority. */
export class JobHistoryIndex {
  private entries = new Map<string, Entry>();
  private pending?: Promise<void>;
  private corrupt = 0;
  private unavailable = 0;
  private readonly root: string;
  private directoryStamp = "";
  private namespace = new Set<string>();
  private scannedAt = 0;
  private contentScannedAt = 0;
  // Per-job invalidation lasts only for the current refresh, including readdir.
  // Own writes are authoritative; unrelated receipt reads remain valid.
  private scanWrites?: Set<string>;
  readonly counters = { scans: 0, receiptStats: 0, receiptReads: 0 };
  /** Own writes update immediately. Namespace checks avoid timestamp collisions;
   * metadata scans run at 1s and a 30s content sweep bounds undetectable edits. */
  beforeWrite() { const s = statSync(this.root, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.ctimeNs}`; }
  private committed(before?: string) {
    // Only absorb our directory mutation if no external mutation preceded it.
    if (before === this.directoryStamp) this.directoryStamp = this.beforeWrite();
  }
  upsert(meta: { id: string; startedAt: string; state: string }, before?: string) {
    this.committed(before);
    this.scanWrites?.add(meta.id);
    this.namespace.add(meta.id + ".json");
    this.entries.set(meta.id, { id: meta.id, startedAt: meta.startedAt, state: meta.state, stamp: "local" });
  }
  remove(id: string, before?: string) { this.committed(before); this.scanWrites?.add(id); this.namespace.delete(id + ".json"); this.entries.delete(id); }
  freshness() { return { reconciledAt: this.scannedAt || null, ageMs: this.scannedAt ? Date.now() - this.scannedAt : null, contentReconciledAt: this.contentScannedAt || null, metadataIntervalMs: 1000, externalMaxAgeMs: 30000, ...this.counters }; }
  constructor(root: string) { this.root = root; }
  private async refresh() {
    if (this.pending) return this.pending;
    const writes = this.scanWrites = new Set<string>();
    const pending = (async () => {
      const directory = await stat(this.root, { bigint: true });
      const stamp = `${directory.ino}:${directory.mtimeNs}:${directory.ctimeNs}`;
      const names = (await readdir(this.root)).filter(name => name.endsWith(".json"));
      // Filesystems can reuse even nanosecond timestamps within one clock tick.
      // Compare names without statting receipts so namespace changes are not lost.
      const changed = names.length !== this.namespace.size || names.some(name => !this.namespace.has(name));
      const contentDue = !this.contentScannedAt || Date.now() - this.contentScannedAt >= 30000;
      if (!changed && !contentDue && stamp === this.directoryStamp && Date.now() - this.scannedAt < 1000) return;
      await this.scan(names, writes, contentDue);
      const namespace = new Set(names);
      for (const id of writes) {
        const name = id + ".json";
        if (this.namespace.has(name)) namespace.add(name); else namespace.delete(name);
      }
      this.namespace = namespace;
      this.directoryStamp = stamp;
      this.scannedAt = Date.now();
      if (contentDue) this.contentScannedAt = this.scannedAt;
    })();
    this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) { this.pending = undefined; this.scanWrites = undefined; } }
  }
  private async scan(names: string[], writes: Set<string>, forceRead = false) {
    this.counters.scans++;
    const present = new Set(names.map(name => name.slice(0, -5)));
    for (const id of this.entries.keys()) if (!present.has(id) && !writes.has(id)) this.entries.delete(id);
    let next = 0; let corrupt = 0; let unavailable = 0;
    await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
      while (next < names.length) {
        const name = names[next++]!; const id = name.slice(0, -5); const file = path.join(this.root, name);
        if (writes.has(id)) continue;
        try {
          this.counters.receiptStats++;
          const before = await stat(file);
          const stamp = `${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
          if (!forceRead && this.entries.get(id)?.stamp === stamp) continue;
          this.counters.receiptReads++;
          const meta = JSON.parse(await readFile(file, "utf8"));
          this.counters.receiptStats++;
          const after = await stat(file);
          if (writes.has(id)) continue; // Own transition wins, including repair/removal.
          if (!jobSummarySchema.safeParse(meta).success || meta.id !== id || typeof meta.startedAt !== "string" || !meta.startedAt) throw new Error("invalid_metadata");
          // A concurrent atomic replacement is retried on the next scan.
          this.entries.set(id, { id, startedAt: meta.startedAt, state: meta.state, stamp: after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs ? stamp : "changed" });
        } catch (error) {
          if (writes.has(id)) continue;
          this.entries.delete(id);
          if ((error as NodeJS.ErrnoException).code === "ENOENT") unavailable++; else corrupt++;
        }
      }
    }));
    this.corrupt = corrupt; this.unavailable = unavailable;
  }
  async activeIds() {
    await this.refresh();
    return [...this.entries.values()].filter(entry => entry.state === "running" || entry.state === "cancelling").map(entry => entry.id);
  }
  async page(query: HistoryQuery = {}) {
    const cursor = decodeHistoryCursor(query.cursor);
    await this.refresh();
    const limit = Math.max(1, Math.min(Math.floor(query.limit ?? 100), 1000));
    const sorted = [...this.entries.values()].filter(entry => (!query.state || entry.state === query.state) && (!cursor || compare(entry, cursor) > 0)).sort(compare);
    const items = sorted.slice(0, limit);
    const last = items.at(-1);
    return { freshness: this.freshness(), ids: items.map(item => item.id), nextCursor: sorted.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url") : null, corruptCount: this.corrupt, unavailableCount: this.unavailable, partial: this.corrupt > 0 || this.unavailable > 0 };
  }
}
