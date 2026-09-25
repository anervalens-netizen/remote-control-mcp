import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { AgentClient } from "../apps/mcp-server/src/agent-client.ts";
import { transferFile, syncDirectory } from "../apps/mcp-server/src/transfer-tools.ts";
const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-transfer-bench-"));
const children = [];
const token = randomBytes(24).toString("hex");
async function startAgent(name: string): Promise<string> {
  const child = spawn(process.execPath, ["apps/agent/src/index.ts"], {
    env: { ...process.env, RCMCP_AGENT_HOST: "127.0.0.1", RCMCP_AGENT_PORT: "0", RCMCP_AGENT_TOKEN: token,
      RCMCP_ALLOW_UNAUTHENTICATED: "0", RCMCP_STATE_DIR: path.join(root, name) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Benchmark agent startup timed out")), 15000);
    let output = "";
    const failed = () => { clearTimeout(timer); reject(new Error("Benchmark agent exited before startup")); };
    child.once("exit", failed);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stderr.on("data", () => undefined);
    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-16000);
      const match = output.match(/Server listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); child.off("exit", failed); resolve(match[1]!); }
    });
  });
}
try {
  const [a, b] = await Promise.all([startAgent("agent-a"), startAgent("agent-b")]);
  const client = new AgentClient([{ name: "a", url: a }, { name: "b", url: b }], token);
  const source = path.join(root, "source.bin"), data = randomBytes(8 * 1024 * 1024);
  await writeFile(source, data);
  const samples: Record<string, number[]> = { relay: [], direct: [] };
  for (let i = 0; i < 3; i++) for (const transport of ["relay", "direct"] as const) {
    const destination = path.join(root, transport + ".bin");
    const result = await transferFile(client, { sourceDevice: "a", sourcePath: source, destinationDevice: "b", destinationPath: destination, transport });
    if (!data.equals(await readFile(destination))) throw new Error("Benchmark integrity mismatch");
    samples[transport]!.push(result.durationMs);
  }
  const sourceDir = path.join(root, "tree");
  await mkdir(sourceDir);
  for (let i = 0; i < 32; i++) await writeFile(path.join(sourceDir, `file-${i}.bin`), data.subarray(0, 65536));
  const input = { sourceDevice: "a", sourcePath: sourceDir, destinationDevice: "b", destinationPath: path.join(root, "copy"), compare: "size-mtime" as const };
  const first = await syncDirectory(client, input), second = await syncDirectory(client, input);
  if (second.filesUnchanged !== 32 || second.bytes !== 0) throw new Error("Incremental skip failed");
  console.log(JSON.stringify({ environment: { platform: process.platform, node: process.version, network: "two isolated agents over loopback" },
    bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), samplesMs: samples,
    sync: { files: 32, initialMs: first.durationMs, initialBytes: first.bytes, unchangedMs: second.durationMs, unchangedBytes: second.bytes, filesSkipped: second.filesUnchanged } }, null, 2));
} finally {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  }));
  await rm(root, { recursive: true, force: true });
}
