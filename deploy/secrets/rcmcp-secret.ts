#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";
import { SecretStore } from "../../apps/mcp-server/src/secret-store.ts";

async function readAllStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readHiddenLine(): Promise<Buffer> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return readAllStdin();
  process.stderr.write("Secret value (hidden; Enter to store): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  const chars: string[] = [];
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const onData = (data: string) => {
        for (const char of data) {
          if (char === "\u0003") { cleanup(); reject(new Error("Cancelled")); return; }
          if (char === "\r" || char === "\n") { cleanup(); resolve(Buffer.from(chars.join(""), "utf8")); return; }
          if (char === "\u007f" || char === "\b") { chars.pop(); continue; }
          chars.push(char);
        }
      };
      const cleanup = () => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write("\n");
      };
      process.stdin.on("data", onData);
    });
  } finally {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* already restored */ }
    }
  }
}

function usage(): never {
  console.error("Usage: rcmcp-secret.ts put <alias> [--file path] | status <alias> | list | delete <alias>");
  process.exit(2);
}

const [, , command, alias, ...rest] = process.argv;
const store = new SecretStore();

switch (command) {
  case "put": {
    if (!alias) usage();
    const fileIndex = rest.indexOf("--file");
    const data = fileIndex >= 0 ? await readFile(rest[fileIndex + 1] ?? usage()) : await readHiddenLine();
    const result = await store.put(alias, data);
    console.log(JSON.stringify(result));
    break;
  }
  case "status":
    if (!alias) usage();
    console.log(JSON.stringify(await store.metadata(alias)));
    break;
  case "list":
    console.log(JSON.stringify(await store.list()));
    break;
  case "delete":
    if (!alias) usage();
    console.log(JSON.stringify(await store.delete(alias)));
    break;
  default:
    usage();
}
