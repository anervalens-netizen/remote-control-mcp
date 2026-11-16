// Usage: node --experimental-strip-types scripts/preview-observation-effects.ts /absolute/journal-directory
// Read-only assessment. Does not instantiate OperationObserver (which writes
// coverage metadata), rewrite records, retire observations or replay any work.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assessHistoricalReadFailure } from "../apps/mcp-server/src/operation-observer.ts";

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory) || process.argv.length !== 3) throw new Error("Pass exactly one absolute observation-journal directory");
const root = await fs.lstat(directory);
if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Expected a regular journal directory, not a symlink");
const groups = new Map<string, { tool: string; disposition: string; reason: string; count: number }>();
const counts = { candidate: 0, protected: 0, not_applicable: 0 };
let scannedEntries = 0, unreadableEntries = 0, ignoredEntries = 0;
const files = await fs.readdir(directory);
const pendingTemporaries = new Set(files.filter(name => /^[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/.test(name)).map(name => name.slice(0, 36)));
for (const name of files) {
  if (name === "coverage.json" || name === "coverage.json.tmp") continue;
  if (!/^[a-f0-9-]{36}\.json$/.test(name)) { ignoredEntries++; continue; }
  scannedEntries++;
  let handle;
  try {
    handle = await fs.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 512 * 1024) throw new Error("Invalid entry");
    const buffer = Buffer.alloc(512 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 512 * 1024) throw new Error("Oversized entry");
    const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (`${record.traceId}.json` !== name) throw new Error("Reference mismatch");
    const assessed = assessHistoricalReadFailure(record);
    const assessment = assessed.disposition === "candidate" && pendingTemporaries.has(record.traceId)
      ? { disposition: "protected" as const, reason: "temporary_evidence", tool: assessed.tool }
      : assessed;
    counts[assessment.disposition]++;
    const group = { tool: "tool" in assessment ? assessment.tool : "unclassified", disposition: assessment.disposition, reason: assessment.reason };
    const key = JSON.stringify(group);
    const existing = groups.get(key);
    if (existing) existing.count++; else groups.set(key, { ...group, count: 1 });
  } catch { unreadableEntries++; counts.protected++; }
  finally { await handle?.close(); }
}
console.log(JSON.stringify({
  version: 1, mode: "read_only", scannedEntries, unreadableEntries, ignoredEntries, counts,
  groups: [...groups.values()].sort((a, b) => a.tool.localeCompare(b.tool) || a.reason.localeCompare(b.reason)),
  decision: "No records changed. Candidates require deployed-contract/version review before a separate journal migration. Historical mixed calls without per-call evidence remain protected.",
}, null, 2));
