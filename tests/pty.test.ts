import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ptyInput, ptyList, ptyOutput, ptyRemove, ptyResize, ptyStart, ptyTerminate } from "../apps/agent/src/pty.ts";
import { processAlive } from "../apps/agent/src/process-identity.ts";

async function waitFor(id: string, marker: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = ptyOutput(id);
    if (output.data.includes(marker)) return output;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PTY marker not found: ${marker}`);
}

async function waitForMatch(id: string, pattern: RegExp, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = ptyOutput(id);
    const match = pattern.exec(output.data);
    if (match) return { output, match };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PTY pattern not found: ${pattern}`);
}

describe("persistent PTY", () => {
  it("syncs output before publishing terminal exit metadata", () => {
    const source = readFileSync(path.resolve("apps/agent/src/pty.ts"), "utf8");
    const exitHandler = source.slice(source.indexOf("terminal.onExit"), source.indexOf("return { id, pid:", source.indexOf("terminal.onExit")));
    expect(exitHandler.indexOf("syncOutputForTerminalState")).toBeGreaterThan(-1);
    expect(exitHandler.indexOf("session.meta.state = \"exited\"")).toBeGreaterThan(exitHandler.indexOf("syncOutputForTerminalState"));
    expect(exitHandler.lastIndexOf("writeMetaRecoverably(session.meta")).toBeGreaterThan(exitHandler.indexOf("session.meta.state = \"exited\""));
  });

  it.skipIf(process.platform === "win32")("rejects an invalid signal without terminating the PTY", async () => {
    const session = await ptyStart({ shell: "/bin/bash" });
    try {
      ptyInput(session.id, "echo INVALID_SIGNAL_READY\n");
      await waitFor(session.id, "INVALID_SIGNAL_READY");

      await expect(ptyTerminate(session.id, "SIGTREm")).rejects.toThrow("Unknown signal: SIGTREm");
      expect(processAlive(session.pid)).toBe(true);

      ptyInput(session.id, "echo STILL_ALIVE\n");
      const output = await waitFor(session.id, "STILL_ALIVE");
      expect(output.data).toContain("STILL_ALIVE");
    } finally {
      await ptyTerminate(session.id).catch(() => undefined);
      await ptyRemove(session.id, true).catch(() => undefined);
    }
  });

  it.skipIf(process.platform === "win32")("terminates a TERM-resistant PTY process group before claiming verification", async () => {
    const session = await ptyStart({ shell: "/bin/bash" });
    try {
      ptyInput(session.id, "trap '' TERM; (trap '' TERM; sleep 20) & echo CHILD=$!; wait\n");
      const { match } = await waitForMatch(session.id, /CHILD=(\d+)/);
      const childPid = Number.parseInt(match[1]!, 10);
      expect(() => process.kill(childPid, 0)).not.toThrow();

      const ended = await ptyTerminate(session.id);
      expect(ended).toMatchObject({ ok: true, state: "exited", exited: true, terminationVerified: true, forced: true });
      expect(processAlive(childPid)).toBe(false);
      expect(processAlive(session.pid)).toBe(false);
    } finally {
      await ptyRemove(session.id, true).catch(() => undefined);
    }
  });

  it.skipIf(process.platform === "win32")("tracks a child spawned during TERM after it creates a new session", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-pty-dynamic-child-"));
    const spawnFile = path.join(root, "spawn.pid");
    const childScript = path.join(root, "spawn-on-term.cjs");
    await writeFile(childScript, [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'let spawned = false;',
      'process.on("SIGTERM", () => {',
      '  if (spawned) return;',
      '  spawned = true;',
      '  const child = spawn("/bin/sleep", ["20"], { detached: true, stdio: "ignore", env: process.env });',
      '  fs.writeFileSync(process.env.SPAWN_FILE, String(child.pid));',
      '});',
      'console.log("DYNAMIC_READY");',
      'setInterval(() => {}, 1000);',
    ].join("\n") + "\n");

    const session = await ptyStart({ shell: "/bin/bash", env: { SPAWN_FILE: spawnFile } });
    try {
      ptyInput(session.id, "node " + childScript + "\n");
      await waitFor(session.id, "DYNAMIC_READY");

      const ended = await ptyTerminate(session.id);
      expect(ended).toMatchObject({ ok: true, exited: true, terminationVerified: true, forced: true });

      const childPid = Number.parseInt((await readFile(spawnFile, "utf8")).trim(), 10);
      expect(Number.isFinite(childPid)).toBe(true);
      expect(processAlive(childPid)).toBe(false);
    } finally {
      await ptyRemove(session.id, true).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("delivers the initial TERM only once to each tracked PTY process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-pty-single-signal-"));
    const signalFile = path.join(root, "signals.txt");
    const childScript = path.join(root, "count-term.cjs");
    await writeFile(childScript, [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => fs.appendFileSync(process.env.SIGNAL_FILE, "T"));',
      'console.log("SIGNAL_READY");',
      'setInterval(() => {}, 1000);',
    ].join("\n") + "\n");

    const session = await ptyStart({ shell: "/bin/bash", env: { SIGNAL_FILE: signalFile } });
    try {
      ptyInput(session.id, "node " + childScript + " & echo CHILD=$!\n");
      await waitFor(session.id, "SIGNAL_READY");

      const ended = await ptyTerminate(session.id);
      expect(ended).toMatchObject({ ok: true, exited: true, terminationVerified: true, forced: true });
      expect(await readFile(signalFile, "utf8")).toBe("T");
    } finally {
      await ptyRemove(session.id, true).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves shell state across calls and supports resize", async () => {
    const windows = process.platform === "win32";
    const session = await ptyStart({ ...(windows ? {} : { shell: "/bin/bash" }), cols: 80, rows: 24 });
    try {
      ptyInput(session.id, windows ? "$env:RCMCP_TEST=\"persisted\"; Write-Output FIRST\r" : "export RCMCP_TEST=persisted\necho FIRST\n");
      const first = await waitFor(session.id, "FIRST");
      ptyResize(session.id, 132, 44);
      ptyInput(session.id, windows ? "Write-Output \"STATE=$env:RCMCP_TEST\"\r" : "echo STATE=$RCMCP_TEST\n");
      const second = await waitFor(session.id, "STATE=persisted");
      expect(second.data).toContain("STATE=persisted");
      const listed = ptyList().find((item) => item.id === session.id);
      expect(listed).toMatchObject({ cols: 132, rows: 44 });
      expect(first.nextOffset).toBeGreaterThan(0);
    } finally {
      const ended = await ptyTerminate(session.id);
      expect(ended).toMatchObject({ ok: true, exited: true });
      await ptyRemove(session.id);
    }
  });
});
