import { readFileSync } from "node:fs";
import { reconciliationEvidenceSchema } from "../apps/mcp-server/src/contextkeep-journal.ts";
import path from "node:path";
import { historicallyResolveEntry } from "../apps/mcp-server/src/contextkeep-journal.ts";

const [directory, recoveryDirectory, key, expectedHash, expectedJobId, expectedRunId, evidenceRecordId, evidenceFile] = process.argv.slice(2);
if (!directory || !recoveryDirectory || !key || !expectedHash || !expectedJobId || !expectedRunId || !evidenceRecordId || !evidenceFile || !path.isAbsolute(evidenceFile) ||
    !path.isAbsolute(directory) || !path.isAbsolute(recoveryDirectory)) {
  throw new Error("Usage: node scripts/resolve-contextkeep-history.ts <absolute-directory> <absolute-recovery-directory> <key> <hash> <jobId> <runId> <evidenceRecordId> <absolute-evidence-json>");
}
const entry = historicallyResolveEntry(directory, recoveryDirectory, {
  evidence: reconciliationEvidenceSchema.parse(JSON.parse(readFileSync(evidenceFile, "utf8"))),
  key, expectedHash, expectedJobId, expectedRunId, evidenceRecordId,
});
console.log(JSON.stringify({
  ok: true, version: entry.version, state: entry.state, key: entry.key, jobId: entry.jobId,
  runId: entry.correlation.runId, historicalResolution: entry.version === 3 ? entry.historicalResolution : undefined,
}));
