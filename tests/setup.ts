import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll } from "vitest";

const stateDir = path.join(os.tmpdir(), `rcmcp-vitest-${process.pid}-${randomUUID()}`);
mkdirSync(stateDir, { recursive: true });
process.env.RCMCP_STATE_DIR = stateDir;

afterAll(() => rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
