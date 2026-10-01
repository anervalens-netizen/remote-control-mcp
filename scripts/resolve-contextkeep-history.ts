import path from "node:path";
import { historicallyResolveEntry } from "../apps/mcp-server/src/contextkeep-journal.ts";

const [directory, recoveryDirectory, key, expectedHash, expectedJobId, expectedRunId, evidenceRecordId] = process.argv.slice(2);
if (!directory || !recoveryDirectory || !key || !expectedHash || !expectedJobId || !expectedRunId || !evidenceRecordId ||
    !path.isAbsolute(directory) || !path.isAbsolute(recoveryDirectory)) {
  throw new Error("Usage: node scripts/resolve-contextkeep-history.ts <absolute-directory> <absolute-recovery-directory> <key> <hash> <jobId> <runId> <evidenceRecordId>");
}
const entry = historicallyResolveEntry(directory, recoveryDirectory, {
  key, expectedHash, expectedJobId, expectedRunId, evidenceRecordId,
});
console.log(JSON.stringify({
  ok: true, version: entry.version, state: entry.state, key: entry.key, jobId: entry.jobId,
  runId: entry.correlation.runId, historicalResolution: entry.version === 3 ? entry.historicalResolution : undefined,
}));
