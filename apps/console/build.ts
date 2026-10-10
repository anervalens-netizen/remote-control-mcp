import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { mkdir, writeFile, chmod, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("./", import.meta.url));
const release = process.env.RCMCP_RUNTIME_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(release)) throw new Error("An exact release SHA is required");
const result = await build({ absWorkingDir: root, entryPoints: ["src/main.tsx"], bundle: true, write: false, minify: true, sourcemap: "external", sourcesContent: true,
  format: "iife", platform: "browser", target: "es2022", outfile: "console.js", legalComments: "inline", define: { __GLITCHTIP_DSN__: JSON.stringify(process.env.GLITCHTIP_DSN || ""), __GLITCHTIP_RELEASE__: JSON.stringify(release), "process.env.NODE_ENV": '"production"' } });
const rawScript = result.outputFiles.find(file => file.path.endsWith(".js"))!.text;
// esbuild escapes closing script tags. Refuse any additional text transform that
// would invalidate the generated coordinates in the private source map.
if (rawScript.includes("</script") || rawScript.includes("sourceMappingURL=")) throw new Error("Unsafe inline script boundary");
const script = rawScript + "\n//# sourceURL=app:///mcp/console.js\n";
const sourceMap = result.outputFiles.find(file => file.path.endsWith(".js.map"))!.text;
const privateRoot = new URL("../../artifacts/private-source-maps/console/", import.meta.url);
for (const relative of ["../../artifacts/", "../../artifacts/private-source-maps/", "../../artifacts/private-source-maps/console/"]) {
  const directory = new URL(relative, import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Private artifact directory must not be a symlink");
  await chmod(directory, 0o700);
}
for (const name of ["console.js", "console.js.map", "manifest.json"]) {
  const file = new URL(name, privateRoot);
  try { if (!(await lstat(file)).isFile()) throw new Error("Private artifact must be a regular file"); await chmod(file, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
await writeFile(new URL("console.js", privateRoot), script, { mode: 0o600 });
await writeFile(new URL("console.js.map", privateRoot), sourceMap, { mode: 0o600 });
await writeFile(new URL("manifest.json", privateRoot), JSON.stringify({release, files:{"console.js":{
  js:createHash("sha256").update(script).digest("hex"), map:createHash("sha256").update(sourceMap).digest("hex")
}}}) + "\n", { mode: 0o600 });
for (const name of ["console.js", "console.js.map", "manifest.json"]) await chmod(new URL(name, privateRoot), 0o600);
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Control Console</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/console.html", import.meta.url), html);
await writeFile(new URL("dist/manifest.json", import.meta.url), JSON.stringify({ version: 1, sha256: createHash("sha256").update(html).digest("hex"), bytes: Buffer.byteLength(html) }) + "\n");
console.log(`Console built: ${Buffer.byteLength(html)} bytes`);
