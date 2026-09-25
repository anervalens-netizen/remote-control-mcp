import { setTimeout as delay } from "node:timers/promises";
import type { JobFollowInput } from "../../../packages/protocol/src/project.ts";
import { jobOutput, jobStatusAsync } from "./jobs.ts";
import { utf8SafeLength, utf8LeadingCodePointLength } from "./state.ts";

function page(id: string, stream: "stdout" | "stderr", offset: number, length: number, encoding: "utf8" | "base64", terminal: boolean) {
  const raw = jobOutput({ id, stream, offset, length: Math.max(4, length), encoding: "base64" });
  const bytes = Buffer.from(raw.data, "base64");
  let count = Math.min(bytes.length, length);
  if (encoding === "utf8") {
    const safe = utf8SafeLength(bytes.subarray(0, count));
    if (safe < count && (count < bytes.length || !raw.eof || !terminal)) count = safe;
    if (count === 0 && bytes.length > 0) {
      const leading = utf8LeadingCodePointLength(bytes);
      count = bytes.length < leading && terminal && raw.eof ? bytes.length : utf8SafeLength(bytes.subarray(0, Math.min(leading, bytes.length)));
    }
  }
  const data = bytes.subarray(0, count);
  return { stream, offset: raw.offset, nextOffset: raw.offset + count, totalBytes: raw.totalBytes,
    eof: raw.offset + count >= raw.totalBytes, data: data.toString(encoding), bytes: count, encoding };
}
export async function jobFollow(input: JobFollowInput, signal?: AbortSignal) {
  const start = performance.now(), waitMs = input.waitMs ?? 30000;
  const cursor = input.cursor ?? { stdout: 0, stderr: 0 };
  const encoding = input.encoding ?? "utf8", maxBytes = input.maxBytes ?? 64 * 1024;
  let status = await jobStatusAsync(input.id);
  while (status.state === "running" || status.state === "cancelling") {
    signal?.throwIfAborted();
    if (input.until === "output" && (status.stdoutBytes > cursor.stdout || status.stderrBytes > cursor.stderr)) {
      if (page(input.id, "stdout", cursor.stdout, maxBytes, encoding, false).bytes || page(input.id, "stderr", cursor.stderr, maxBytes, encoding, false).bytes) break;
    }
    const remaining = waitMs - (performance.now() - start);
    if (remaining <= 0) break;
    await delay(Math.min(remaining, 200), undefined, { signal });
    status = await jobStatusAsync(input.id);
  }
  const terminal = status.state !== "running" && status.state !== "cancelling";
  const stdout = page(input.id, "stdout", cursor.stdout, maxBytes, encoding, terminal);
  const stderr = page(input.id, "stderr", cursor.stderr, maxBytes, encoding, terminal);
  return { ...status, terminal, waitExpired: !terminal && performance.now() - start >= waitMs,
    stdout, stderr, cursor: { stdout: stdout.nextOffset, stderr: stderr.nextOffset },
    outputComplete: terminal && stdout.eof && stderr.eof, waitedMs: Math.round(performance.now() - start) };
}
