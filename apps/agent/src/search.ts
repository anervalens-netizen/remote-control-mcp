import { spawn } from "node:child_process";
import process from "node:process";
import {
  buildSearchArgs,
  classifyRipgrepFailure,
  createFileMatcher,
  normalizeFileResult,
  parseRgMatchLine,
  SEARCH_SIMPLE_MAX_BYTES,
  searchResponseBytes,
} from "./search-common.ts";

const rgPath = process.env.RCMCP_RG_PATH ?? "rg";
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_PENDING_JSON_CHARS = 4 * 1024 * 1024;

export type SearchInput = {
  path: string;
  pattern: string;
  mode?: "content" | "files";
  literal?: boolean;
  ignoreCase?: boolean;
  hidden?: boolean;
  glob?: string;
  globs?: string[];
  types?: string[];
  excludeTypes?: string[];
  follow?: boolean;
  noIgnore?: boolean;
  maxFileSizeBytes?: number;
  maxResults?: number;
};

type FileSearchResult = Array<{ path: string }> | {
  results: Array<{ path: string }>;
  limited: true;
  maxResults: number;
  truncated: true;
  byteTruncated?: true;
  countTruncated?: true;
};

async function collectFileResults(
  file: string,
  args: string[],
  cwd: string,
  resultBase: string,
  matcher: (value: string) => boolean,
  maxResults: number,
): Promise<FileSearchResult> {
  const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const results: Array<{ path: string }> = [];
  let pending = "";
  let stderr = "";
  let limited = false;
  let byteTruncated = false;
  let countTruncated = false;

  const parseLine = (line: string) => {
    if (!line || limited) return;
    const value = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!matcher(value)) return;
    const result = { path: normalizeFileResult(resultBase, value) };
    if (searchResponseBytes({
      results: [...results, result], limited: true, maxResults, truncated: true, byteTruncated: true,
    }) > SEARCH_SIMPLE_MAX_BYTES) {
      limited = true;
      byteTruncated = true;
      child.kill("SIGTERM");
      return;
    }
    // Do not call an exactly-full result set truncated. We only know that
    // maxResults omitted data after observing one additional matching entry.
    if (results.length >= maxResults) {
      limited = true;
      countTruncated = true;
      child.kill("SIGTERM");
      return;
    }
    results.push(result);
  };

  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
    if (pending.length > MAX_PENDING_JSON_CHARS) {
      limited = true;
      byteTruncated = true;
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (!limited && pending) parseLine(pending);
  if (!limited && code !== 0 && code !== 1) throw classifyRipgrepFailure(code, stderr);
  if (limited) {
    return {
      results,
      limited: true,
      maxResults,
      truncated: true,
      ...(byteTruncated ? { byteTruncated: true as const } : {}),
      ...(countTruncated ? { countTruncated: true as const } : {}),
    };
  }
  return results;
}

function resultIsClipped(result: Record<string, unknown>): boolean {
  return result.textTruncated === true || result.submatchesTruncated === true;
}

export async function search(input: SearchInput) {
  const maxResults = input.maxResults ?? 100;
  const { args, cwd, resultBase } = buildSearchArgs(input);
  if (input.mode === "files") {
    const matcher = createFileMatcher(input);
    return collectFileResults(rgPath, args, cwd, resultBase, matcher, maxResults);
  }

  const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const results: Array<Record<string, unknown>> = [];
  let pending = "";
  let stderr = "";
  let limited = false;
  let contentTruncated = false;
  let parseError: Error | null = null;

  const responseShape = (
    candidate: Array<Record<string, unknown>>,
    candidateLimited: boolean,
    candidateTruncated: boolean,
  ) => ({
    results: candidate,
    limited: candidateLimited,
    maxResults,
    truncated: candidateTruncated,
  });

  const parseLine = (line: string) => {
    if (!line || limited || parseError) return;
    try {
      const result = parseRgMatchLine(line, resultBase);
      if (!result) return;
      const resultRecord = result as Record<string, unknown>;
      const clipped = resultIsClipped(resultRecord);
      const candidate = [...results, resultRecord];
      const candidateWouldTruncate = contentTruncated || clipped;
      if (searchResponseBytes(responseShape(candidate, true, true)) > SEARCH_SIMPLE_MAX_BYTES) {
        limited = true;
        contentTruncated = true;
        child.kill("SIGTERM");
        return;
      }
      results.push(resultRecord);
      contentTruncated ||= candidateWouldTruncate;
      if (results.length >= maxResults) {
        limited = true;
        child.kill("SIGTERM");
      }
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
    }
  };

  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > MAX_PENDING_JSON_CHARS && !pending.includes("\n")) {
      parseError = new Error(
        `ripgrep emitted a JSON result line larger than ${MAX_PENDING_JSON_CHARS} characters; use a narrower search or read the file directly`,
      );
      child.kill("SIGTERM");
      return;
    }
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
  });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (!limited && !parseError && pending) parseLine(pending);
  if (parseError) throw parseError;
  if (!limited && code !== 0 && code !== 1) throw classifyRipgrepFailure(code, stderr);

  const truncated = limited || contentTruncated;
  return responseShape(results, limited, truncated);
}
