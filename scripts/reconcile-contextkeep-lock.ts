import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { reconcileOrphanLock } from "../apps/mcp-server/src/contextkeep-journal.ts";
const [directory, recoveryDirectory, evidenceFile, fence] = process.argv.slice(2);
if (!directory || !recoveryDirectory || !evidenceFile || ![directory, recoveryDirectory, evidenceFile].every(path.isAbsolute) || fence !== "--writers-fenced") {
  throw new Error("Usage: node scripts/reconcile-contextkeep-lock.ts <absolute-journal> <absolute-recovery> <absolute-evidence-json> --writers-fenced. Stop/fence all journal writers first. Evidence must include originalReceipt, key, expectedLockSha256 and the complete historical evidence tuple.");
}
if (statSync(evidenceFile).size > 128 * 1024) throw new Error("Evidence exceeds bound");
const input = JSON.parse(readFileSync(evidenceFile, "utf8"));
const result = reconcileOrphanLock(directory, recoveryDirectory, { ...input, writersFenced: true });
console.log(JSON.stringify({ key: result.key, state: result.state, attachAcknowledged: result.attachAcknowledged }));
