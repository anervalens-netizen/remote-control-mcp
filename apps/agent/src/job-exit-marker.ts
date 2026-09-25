import { closeSync, existsSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function writeExitMarkerDurably(destination: string, code: number, logFiles: string[] = []) {
  for (const logPath of logFiles) {
    if (!existsSync(logPath)) continue;
    const log = openSync(logPath, "r+");
    try { fsyncSync(log); } finally { closeSync(log); }
  }
  const temporary = destination + ".tmp." + process.pid;
  writeFileSync(temporary, String(code) + "\n", { mode: 0o600 });
  const file = openSync(temporary, "r+");
  try { fsyncSync(file); } finally { closeSync(file); }
  renameSync(temporary, destination);
  if (process.platform !== "win32") {
    const directory = openSync(path.dirname(destination), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv[2];
  const code = Number.parseInt(process.argv[3] ?? "", 10);
  const logFiles = process.argv.slice(4);
  if (!destination || !Number.isFinite(code)) throw new Error("usage: job-exit-marker <destination> <exit-code> [log-file...]");
  writeExitMarkerDurably(destination, code, logFiles);
}
