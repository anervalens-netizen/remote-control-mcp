import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

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
  private readonly root: string;
  constructor(root: string) { this.root = root; }
  private async refresh() {
    if (this.pending) return this.pending;
    const pending = this.scan();
    this.pending = pending;
    try { await pending; } finally { if (this.pending === pending) this.pending = undefined; }
  }
  private async scan() {
    const names = (await readdir(this.root)).filter(name => name.endsWith(".json"));
    const present = new Set(names.map(name => name.slice(0, -5)));
    for (const id of this.entries.keys()) if (!present.has(id)) this.entries.delete(id);
    let next = 0; let corrupt = 0;
    await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
      while (next < names.length) {
        const name = names[next++]!; const id = name.slice(0, -5); const file = path.join(this.root, name);
        try {
          const before = await stat(file);
          const stamp = `${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
          if (this.entries.get(id)?.stamp === stamp) continue;
          const meta = JSON.parse(await readFile(file, "utf8"));
          const after = await stat(file);
          if (meta.id !== id || typeof meta.startedAt !== "string" || !["running", "cancelling", "completed", "cancelled", "lost"].includes(meta.state)) throw new Error("invalid_metadata");
          // A concurrent atomic replacement is retried on the next scan.
          this.entries.set(id, { id, startedAt: meta.startedAt, state: meta.state, stamp: after.ino === before.ino && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs ? stamp : "changed" });
        } catch { this.entries.delete(id); corrupt++; }
      }
    }));
    this.corrupt = corrupt;
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
    return { ids: items.map(item => item.id), nextCursor: sorted.length > limit && last ? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url") : null, corruptCount: this.corrupt, partial: this.corrupt > 0 };
  }
}
