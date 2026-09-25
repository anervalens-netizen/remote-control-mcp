import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { FsEditInput } from "../../../packages/protocol/src/editing.ts";
import { fsWrite } from "./filesystem.ts";

const lanes = new Map<string, Promise<unknown>>();
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function fsEdit(input: FsEditInput) {
  const resolvedPath = await realpath(input.path);
  const key = process.platform === "win32" ? path.resolve(resolvedPath).toLowerCase() : resolvedPath;
  const previous = lanes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => edit(input));
  lanes.set(key, next);
  try { return await next; }
  finally { if (lanes.get(key) === next) lanes.delete(key); }
}

async function edit(input: FsEditInput) {
  const original = await readFile(input.path);
  if (!isUtf8(original)) throw new Error("fs_edit requires valid UTF-8; use fs_write with base64 for binary files");
  const beforeSha256 = sha256(original);
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== beforeSha256) throw new Error("File SHA-256 differs from expectedSha256; no edits applied");
  let content = original.toString("utf8");
  const replacements: number[] = [];
  for (const [index, change] of input.edits.entries()) {
    if (!change.oldText) throw new Error("oldText must be nonempty");
    const parts = content.split(change.oldText);
    const count = parts.length - 1;
    const expected = change.expectedOccurrences ?? 1;
    if (count !== expected) throw new Error(`Edit ${index}: expected ${expected} occurrences, found ${count}; no edits applied`);
    replacements.push(count);
    // Literal join avoids replacement-string interpretation of $&, $1, etc.
    content = parts.join(change.newText);
  }
  const updated = Buffer.from(content, "utf8");
  const afterSha256 = sha256(updated);
  const result = { path: input.path, beforeSha256, afterSha256, replacements,
    beforeBytes: original.length, afterBytes: updated.length, changed: !original.equals(updated) };
  if (input.dryRun) return { ...result, applied: false, dryRun: true };
  if (!result.changed) return { ...result, applied: false, reason: "no_changes" };
  // Best-effort freshness check against external editors; this is not an OS
  // compare-and-swap. Calls to fs_edit for the same real path are serialized.
  if (sha256(await readFile(input.path)) !== beforeSha256) throw new Error("File changed during edit preparation; no edits applied");
  const write = await fsWrite({ path: input.path, data: content });
  const verifiedSha256 = sha256(await readFile(input.path));
  return { ...result, applied: true, verified: verifiedSha256 === afterSha256, verifiedSha256, write };
}
