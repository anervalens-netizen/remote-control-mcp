import path from "node:path";
import process from "node:process";

export function runtimeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const inherited = process.env.PATH ?? process.env.Path ?? "";
  const runtimeBin = path.dirname(process.execPath);
  return {
    ...process.env,
    PATH: inherited.startsWith(runtimeBin) ? inherited : `${runtimeBin}${path.delimiter}${inherited}`,
    ...extra,
  };
}

export function runtimeStringEnv(extra?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(runtimeEnv(extra)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
