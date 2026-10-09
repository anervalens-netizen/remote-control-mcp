import { test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

test("built console keeps original sources private and embeds the exact mapped script", () => {
  const root = new URL("../", import.meta.url);
  const privateRoot = new URL("artifacts/private-source-maps/console/", root);
  const script = readFileSync(new URL("console.js", privateRoot), "utf8");
  const map = readFileSync(new URL("console.js.map", privateRoot), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", privateRoot), "utf8"));
  const html = readFileSync(new URL("apps/console/dist/console.html", root), "utf8");
  expect(html).toContain(`<script>${script}</script>`);
  expect(script).toContain("//# sourceURL=app:///mcp/console.js");
  expect(html).not.toContain("sourceMappingURL=");
  expect(readdirSync(new URL("apps/console/dist/", root)).filter(x=>x.endsWith(".map"))).toEqual([]);
  expect(JSON.parse(map).sources.some((x:string)=>x.endsWith("error-reporting.ts"))).toBe(true);
  for (const [key,value] of ([["js",script],["map",map]] as const)) expect(manifest.files["console.js"][key]).toBe(createHash("sha256").update(value).digest("hex"));
});
