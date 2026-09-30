import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { jobInputHash } from "../apps/mcp-server/src/contextkeep-bridge.ts";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

it("serializes numeric environment names in code-unit order rather than object enumeration order", () => {
  const env = { "2": "two", "10": "ten", A: "a", "01": "zero" };
  const expected = digest('{"command":"echo fixture","cwd":null,"env":{"01":"zero","10":"ten","2":"two","A":"a"}}');
  expect(jobInputHash({ command: "echo fixture", env })).toBe(expected);
  expect(jobInputHash({ command: "echo fixture", env: Object.fromEntries(Object.entries(env).reverse()) })).toBe(expected);
});
it("retains the existing JSON hash for ordinary environment names and empty environments", () => {
  expect(jobInputHash({ command: "echo fixture", cwd: "/fixture", env: { Z: "last", A: "first" } })).toBe(digest(JSON.stringify({ command: "echo fixture", cwd: "/fixture", env: { A: "first", Z: "last" } })));
  expect(jobInputHash({ command: "echo fixture" })).toBe(digest('{"command":"echo fixture","cwd":null,"env":{}}'));
});
