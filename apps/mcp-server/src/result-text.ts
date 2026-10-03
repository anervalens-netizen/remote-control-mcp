import { utf8SafeLength } from "../../agent/src/state.ts";
export function utf8Preview(value: string, maxBytes: number): string {
  const prefix = Buffer.from(value).subarray(0, maxBytes);
  return prefix.subarray(0, utf8SafeLength(prefix)).toString("utf8");
}
