import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll } from "vitest";

const stateDir = path.join(os.tmpdir(), `rcmcp-vitest-${process.pid}-${randomUUID()}`);
mkdirSync(stateDir, { recursive: true });
process.env.RCMCP_STATE_DIR = stateDir;
// Native runs may inherit an installed agent environment. Fixture state must
// never share its coordination, secret or bridge journal directories.
for (const key of ["RCMCP_COORDINATION_DIR", "RCMCP_SECRET_DIR", "RCMCP_CONTEXTKEEP_STATE_DIR"]) delete process.env[key];
// Existing fixtures explicitly exercise legacy process-lineage guarantees.
// The systemd integration suite enables and qualifies kernel containment.
process.env.RCMCP_JOB_CGROUP_ISOLATION = "0";

// The fingerprint suite creates thousands of files and nested Git repositories.
// Windows deletion (including transient sharing violations) can exceed Vitest's
// default 10s hook budget. Await completion and still fail on a cleanup error;
// this allowance does not change any product deadline or test assertion.
afterAll(() => rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }), process.platform === "win32" ? 60_000 : 10_000);
