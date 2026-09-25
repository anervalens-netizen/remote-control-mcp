import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { SearchInput } from "./search.ts";

type RgString = { text?: string; bytes?: string } | null | undefined;

export const SEARCH_SNIPPET_CHARS = 512;
export const SEARCH_SUBMATCH_TEXT_CHARS = 256;
export const SEARCH_SUBMATCH_LIMIT = 32;
export const SEARCH_SIMPLE_MAX_BYTES = 64 * 1024;

export class SearchInputError extends Error {
  readonly kind: "invalid_regex" | "invalid_path";
  readonly suggestion?: string;

  constructor(kind: "invalid_regex" | "invalid_path", message: string, suggestion?: string) {
    super(message);
    this.name = "SearchInputError";
    this.kind = kind;
    this.suggestion = suggestion;
  }
}

export function invalidRegexError(detail?: string): SearchInputError {
  const suffix = detail?.trim() ? `: ${detail.trim().slice(0, 2048)}` : "";
  return new SearchInputError(
    "invalid_regex",
    `invalid regex pattern${suffix}; use literal=true for literal search`,
    "Set literal=true when the pattern should be matched as plain text.",
  );
}

export function rgString(value: RgString): string {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  throw new Error("ripgrep JSON field has neither text nor bytes");
}

export function createFileMatcher(input: SearchInput): (value: string) => boolean {
  const raw = input.ignoreCase === false ? input.pattern : input.pattern.toLowerCase();
  if (input.literal) return (value) => (input.ignoreCase === false ? value : value.toLowerCase()).includes(raw);
  try {
    const regex = new RegExp(input.pattern, input.ignoreCase === false ? "" : "i");
    return (value) => regex.test(value);
  } catch (error) {
    throw invalidRegexError(error instanceof Error ? error.message : String(error));
  }
}

export function resolvedSearchRoot(input: SearchInput): string {
  return path.resolve(input.path);
}

export type SearchTarget = {
  root: string;
  cwd: string;
  target: string;
  resultBase: string;
  kind: "directory" | "file";
};

export function resolveSearchTarget(input: SearchInput): SearchTarget {
  const root = resolvedSearchRoot(input);
  let entry;
  try {
    entry = statSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SearchInputError("invalid_path", `search path does not exist: ${root}`);
    }
    throw error;
  }
  if (entry.isDirectory()) return { root, cwd: root, target: ".", resultBase: root, kind: "directory" };
  if (entry.isFile()) {
    const cwd = path.dirname(root);
    return { root, cwd, target: path.basename(root), resultBase: cwd, kind: "file" };
  }
  throw new SearchInputError("invalid_path", `search path must be a regular file or directory: ${root}`);
}

function appendTraversalOptions(args: string[], input: SearchInput): void {
  if (input.hidden) args.push("--hidden");
  if (input.follow) args.push("--follow");
  if (input.noIgnore) args.push("--no-ignore");
  if (input.glob) args.push("-g", input.glob);
  for (const glob of input.globs ?? []) args.push("-g", glob);
  for (const type of input.types ?? []) args.push("-t", type);
  for (const type of input.excludeTypes ?? []) args.push("-T", type);
  if (input.maxFileSizeBytes !== undefined) args.push("--max-filesize", String(input.maxFileSizeBytes));
}

export function buildSearchArgs(input: SearchInput): { args: string[] } & SearchTarget {
  const target = resolveSearchTarget(input);
  if (input.mode === "files") {
    const args = ["--files"];
    appendTraversalOptions(args, input);
    args.push("--", target.target);
    return { args, ...target };
  }
  const args = ["--json", "--line-number", "--column", "--color", "never"];
  if (input.literal) args.push("-F");
  if (input.ignoreCase !== false) args.push("-i");
  appendTraversalOptions(args, input);
  args.push("-e", input.pattern, "--", target.target);
  return { args, ...target };
}

export function validatePersistentSearchPattern(input: SearchInput, rgPath: string): void {
  if (input.literal) return;
  if (input.mode === "files") {
    createFileMatcher(input);
    return;
  }

  const probe = spawnSync(rgPath, ["--json", "--color", "never", "-e", input.pattern], {
    input: "",
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  if (probe.error) throw probe.error;
  if (probe.status === 0 || probe.status === 1) return;
  if (probe.status === 2) throw invalidRegexError(probe.stderr);
  throw new Error(`ripgrep regex validation failed (${probe.status}): ${String(probe.stderr ?? "").trim()}`);
}

export function classifyRipgrepFailure(code: number | null, stderr: string): Error {
  if (code === 2 && /regex|repetition operator|unclosed|invalid.*pattern/i.test(stderr)) {
    return invalidRegexError(stderr);
  }
  return new Error(`ripgrep failed (${code}): ${stderr.trim()}`);
}

export function normalizeFileResult(resultBase: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(resultBase, value);
}

function clipped(value: string, maxChars: number): { value: string; truncated: boolean; originalChars: number } {
  if (value.length <= maxChars) return { value, truncated: false, originalChars: value.length };
  return { value: value.slice(0, maxChars), truncated: true, originalChars: value.length };
}

export function parseRgMatchLine(line: string, resultBase?: string) {
  const event = JSON.parse(line) as any;
  if (event.type !== "match") return null;
  const data = event.data;
  const rawText = rgString(data.lines).replace(/\r?\n$/, "");
  const text = clipped(rawText, SEARCH_SNIPPET_CHARS);
  const sourceSubmatches = Array.isArray(data.submatches) ? data.submatches : [];
  const submatches = sourceSubmatches.slice(0, SEARCH_SUBMATCH_LIMIT).map((match: any) => {
    const matchText = clipped(rgString(match.match), SEARCH_SUBMATCH_TEXT_CHARS);
    return {
      text: matchText.value,
      start: match.start,
      end: match.end,
      ...(matchText.truncated ? { textTruncated: true, originalTextChars: matchText.originalChars } : {}),
    };
  });
  return {
    path: resultBase ? normalizeFileResult(resultBase, rgString(data.path)) : rgString(data.path),
    line: data.line_number,
    text: text.value,
    submatches,
    ...(text.truncated ? { textTruncated: true, originalTextChars: text.originalChars } : {}),
    ...(sourceSubmatches.length > SEARCH_SUBMATCH_LIMIT ? {
      submatchesTruncated: true,
      originalSubmatchCount: sourceSubmatches.length,
    } : {}),
  };
}

export function searchResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
