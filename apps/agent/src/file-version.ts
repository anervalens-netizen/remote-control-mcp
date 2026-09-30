import type { BigIntStats } from "node:fs";

/** One filesystem generation; atime is deliberately excluded because reads change it. */
export function fileSignature(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
