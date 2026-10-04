import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll } from "vitest";

const stateDir = path.join(os.tmpdir(), `rcmcp-vitest-${process.pid}-${randomUUID()}`);
mkdirSync(stateDir, { recursive: true });
process.env.RCMCP_STATE_DIR = stateDir;
// Existing fixtures explicitly exercise legacy process-lineage guarantees.
// The systemd integration suite enables and qualifies kernel containment.
process.env.RCMCP_JOB_CGROUP_ISOLATION = "0";

afterAll(() => rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
