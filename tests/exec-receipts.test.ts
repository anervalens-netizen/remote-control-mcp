import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExecReceiptStore } from "../apps/agent/src/exec-receipts.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(entries = 64, bytes = 1024 * 1024, retention = 86400000) {
  const root = mkdtempSync(path.join(os.tmpdir(), "exec-receipt-")); roots.push(root);
  return new ExecReceiptStore(root, entries, bytes, retention);
}
it("recovers a completed command after reconstruction and never executes the ID twice", async () => {
  const store = fixture(), ref = store.prepare(); let effects = 0;
  await store.execute(ref.id, async () => ({ code: 0, stdout: String(++effects) }));
  const restarted = new ExecReceiptStore(store.root);
  const page = restarted.read(ref.id);
  if (!("data" in page)) throw new Error("Expected completed receipt");
  expect(page.state).toBe("complete");
  expect(JSON.parse(Buffer.from(page.data!, "base64").toString())).toEqual({ code: 0, stdout: "1" });
  await expect(restarted.execute(ref.id, async () => ++effects)).rejects.toThrow(/already used/);
  expect(effects).toBe(1);
});
it("claims atomically across store instances before effects and reports unresolved claims truthfully", async () => {
  const first = fixture(), second = new ExecReceiptStore(first.root), ref = first.prepare();
  let release!: () => void, effects = 0;
  const pending = first.execute(ref.id, async () => { effects++; await new Promise<void>(r => { release = r; }); return { code: 0 }; });
  expect(first.read(ref.id).state).toBe("running");
  expect(second.read(ref.id).state).toBe("unknown");
  await expect(second.execute(ref.id, async () => effects++)).rejects.toThrow(/already used/);
  release(); await pending; expect(effects).toBe(1);
});
it("retains uncertainty when a runner throws after effects", async () => {
  const store = fixture(), ref = store.prepare(); let effects = 0;
  await expect(store.execute(ref.id, async () => { effects++; throw new Error("after dispatch"); })).rejects.toThrow();
  expect(new ExecReceiptStore(store.root).read(ref.id).state).toBe("unknown");
  await expect(store.execute(ref.id, async () => effects++)).rejects.toThrow();
  expect(effects).toBe(1);
});
it("refuses unknown, corrupt and expired reservations before dispatch", async () => {
  const store = fixture(); let effects = 0;
  await expect(store.execute(randomUUID(), async () => effects++)).rejects.toThrow(/unavailable/);
  const ref = store.prepare();
  writeFileSync(path.join(store.root, ref.id, "meta.json"), "{}");
  await expect(store.execute(ref.id, async () => effects++)).rejects.toThrow(/unavailable/);
  const expired = fixture(64, 1024, -1), old = expired.prepare();
  await expect(expired.execute(old.id, async () => effects++)).rejects.toThrow(/expired/);
  expect(effects).toBe(0);
});
it("caps retained payloads explicitly and keeps the consumed ID", async () => {
  const store = fixture(1, 100), ref = store.prepare();
  const result = await store.execute(ref.id, async () => ({ stdout: "x".repeat(200) }));
  expect(result.stdout).toHaveLength(200);
  const page = store.read(ref.id);
  if (!("data" in page)) throw new Error("Expected completed receipt");
  expect(JSON.parse(Buffer.from(page.data!, "base64").toString())).toMatchObject({ receiptUnavailable: true, noReplay: true });
  await expect(store.execute(ref.id, async () => 1)).rejects.toThrow();
  store.prepare(); // oldest completed receipt can be shed under pressure
  expect(() => store.prepare()).toThrow(/capacity/); // reserved slot is pinned
  await expect(store.execute(ref.id, async () => 1)).rejects.toThrow(/unavailable/);
});
it("pages exact UTF-8 JSON bytes and rejects traversal and unbounded pages", async () => {
  const store = fixture(), ref = store.prepare(), result = { stdout: "😀".repeat(30) };
  await store.execute(ref.id, async () => result);
  const chunks: Buffer[] = []; let offset = 0;
  for (;;) { const page = store.read(ref.id, offset, 7); if (!("data" in page)) throw new Error("Expected receipt"); chunks.push(Buffer.from(page.data!, "base64")); offset = page.nextOffset!; if (page.eof) break; }
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(result);
  expect(store.read(ref.id, 100000)).toMatchObject({ bytesRead: 0 });
  expect(() => store.read("../elsewhere")).toThrow();
  expect(() => store.read(ref.id, 0, 13000)).toThrow();
});
it("never expires incomplete claimed receipts and never reauthorizes pruned IDs", async () => {
  const store = fixture(2), ref = store.prepare();
  mkdirSync(path.join(store.root, ref.id, "claimed"));
  writeFileSync(path.join(store.root, ref.id, "meta.json"), JSON.stringify({ id: ref.id, createdAt: 0, expiresAt: 1 }));
  const unused = store.prepare();
  writeFileSync(path.join(store.root, unused.id, "meta.json"), JSON.stringify({ id: unused.id, createdAt: 0, expiresAt: 1 }));
  store.prepare();
  expect(store.read(ref.id).state).toBe("unknown");
  await expect(store.execute(unused.id, async () => 1)).rejects.toThrow(/unavailable/);
});


it("expires completed output on read without requiring a new reservation", async () => {
  const store = fixture(), ref = store.prepare();
  await store.execute(ref.id, async () => ({ stdout: "synthetic" }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(ref.expiresAt) + 1);
  try { expect(() => store.read(ref.id)).toThrow(/expired/); }
  finally { clock.mockRestore(); }
});
it("preserves unresolved claims beyond retention", async () => {
  const store = fixture(), ref = store.prepare();
  await expect(store.execute(ref.id, async () => { throw new Error("uncertain"); })).rejects.toThrow();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(ref.expiresAt) + 1);
  try { expect(store.read(ref.id).state).toBe("unknown"); }
  finally { clock.mockRestore(); }
});
