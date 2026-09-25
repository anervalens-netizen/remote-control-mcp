import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { trackProcessLineage, type ProcessLineageTracker } from "../apps/agent/src/process-identity.ts";
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
const native = it.skipIf(process.platform === "win32");
let tracker: ProcessLineageTracker | undefined;
afterEach(() => { tracker?.stop(); vi.mocked(readFileSync).mockReset(); });

native("retires dead history from polls, keeps reparented setsid identities and permission uncertainty", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const boot = actual.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const identity = (ticks: number) => `linux:${boot}:${ticks}`;
  const root = 9000001, child = 9000002, grandchild = 9000003;
  const records = new Map<number, { ticks: number; parent: number; children: number[]; error?: string; state?: string }>();
  records.set(root, { ticks: 1, parent: 0, children: [child] });
  records.set(child, { ticks: 2, parent: root, children: [] });
  const reads = new Map<number, number>();
  vi.mocked(readFileSync).mockImplementation(((file: any, ...args: any[]) => {
    const match = /^\/proc\/(900\d+)\/(stat|task\/\d+\/children)$/.exec(String(file));
    if (!match) return (actual.readFileSync as any)(file, ...args);
    const pid = Number(match[1]), record = records.get(pid);
    reads.set(pid, (reads.get(pid) ?? 0) + 1);
    if (!record || record.error) throw Object.assign(new Error("fixture"), { code: record?.error ?? "ENOENT" });
    if (match[2] !== "stat") return record.children.join(" ");
    const fields = Array(20).fill("0");
    fields[0] = record.state ?? "S"; fields[1] = String(record.parent); fields[2] = fields[3] = String(pid); fields[19] = String(record.ticks);
    return `${pid} (fixture) ${fields.join(" ")}`;
  }) as typeof readFileSync);
  const history = Array.from({ length: 559 }, (_, i) => ({ pid: 9001000 + i, identity: identity(1000 + i) }));
  tracker = trackProcessLineage(root, identity(1), history, undefined, 60000);
  expect(tracker.snapshot()).toHaveLength(561);
  const historicalReads = reads.get(history[0]!.pid);
  records.delete(root); // Child has a new session and survives reparenting.
  records.get(child)!.parent = 1;
  records.get(child)!.error = "EACCES";
  tracker.capture();
  delete records.get(child)!.error;
  records.get(child)!.children = [grandchild];
  records.set(grandchild, { ticks: 3, parent: child, children: [] });
  for (let i = 0; i < 10; i++) tracker.capture();
  expect(reads.get(history[0]!.pid)).toBe(historicalReads);
  expect(tracker.snapshot()).toContainEqual({ pid: grandchild, identity: identity(3) });
  expect(tracker.snapshot()).toHaveLength(562); // Durable history is unchanged.
  records.get(child)!.ticks = 99; // Reused PID is not lineage authority.
  tracker.capture();
  const retiredReads = reads.get(child);
  tracker.capture();
  expect(reads.get(child)).toBe(retiredReads);
});
