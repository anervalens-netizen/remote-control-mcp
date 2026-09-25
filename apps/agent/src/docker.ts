import { summarizeDockerSnapshot, type DockerSnapshot } from "../../../packages/protocol/src/filtering.ts";
export { summarizeDockerSnapshot } from "../../../packages/protocol/src/filtering.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runtimeEnv } from "./runtime-env.ts";
const execFileAsync = promisify(execFile);

async function docker(args: string[], allowFailure = false) {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { env: runtimeEnv(), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error: any) {
    if (!allowFailure) throw error;
    return { ok: false, stdout: error?.stdout?.toString?.().trim?.() ?? "", stderr: error?.stderr?.toString?.().trim?.() ?? error?.message ?? String(error) };
  }
}
function jsonLines(value: string) { return value.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } }); }

export async function dockerSnapshot() {
  const version = await docker(["version", "--format", "{{json .}}"], true);
  const containers = await docker(["ps", "-a", "--format", "{{json .}}"], true);
  const images = await docker(["images", "--format", "{{json .}}"], true);
  const compose = await docker(["compose", "ls", "--format", "json"], true);
  return {
    available: version.ok,
    version: version.ok && version.stdout ? JSON.parse(version.stdout) : null,
    containers: containers.ok ? jsonLines(containers.stdout) : [],
    images: images.ok ? jsonLines(images.stdout) : [],
    compose: compose.ok && compose.stdout ? JSON.parse(compose.stdout) : [],
    errors: [version, containers, images, compose].filter((item) => !item.ok).map((item) => item.stderr),
  };
}


export async function dockerSummary(input: { query?: string; state?: "all" | "running" | "stopped"; limit?: number } = {}) {
  return summarizeDockerSnapshot(await dockerSnapshot() as DockerSnapshot, input);
}
