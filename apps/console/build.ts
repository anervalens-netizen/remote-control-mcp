import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("./", import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ["src/main.tsx"], bundle: true, write: false, minify: true,
  format: "iife", platform: "browser", target: "es2022", outfile: "console.js", legalComments: "inline", define: { "process.env.NODE_ENV": '"production"' } });
const script = result.outputFiles.find(file => file.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script");
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote Control Console</title><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`;
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/console.html", import.meta.url), html);
await writeFile(new URL("dist/manifest.json", import.meta.url), JSON.stringify({ version: 1, sha256: createHash("sha256").update(html).digest("hex"), bytes: Buffer.byteLength(html) }) + "\n");
console.log(`Console built: ${Buffer.byteLength(html)} bytes`);
