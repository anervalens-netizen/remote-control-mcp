import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it.skipIf(process.platform !== "win32")("closes native ConPTY repeatedly and preserves explicit partial termination scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-conpty-"));
  const moduleUrl = new URL("../apps/agent/src/pty.ts", import.meta.url).href;
  const script = `
    const pty = await import(${JSON.stringify(moduleUrl)});
    for (const shell of ["cmd.exe", "powershell.exe", "cmd.exe"]) {
      const session = await pty.ptyStart({ shell });
      pty.ptyResize(session.id, 100, 30);
      pty.ptyInput(session.id, "echo CONPTY_NATIVE_READY\\r");
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (pty.ptyOutput(session.id, 0, 65536).data.includes("CONPTY_NATIVE_READY")) { ready = true; break; }
        await new Promise(r => setTimeout(r, 30));
      }
      if (!ready) throw new Error("Native PTY output missing");
      const result = await pty.ptyTerminate(session.id);
      if (!result.exited || result.terminationVerified || !result.terminationVerification || !result.terminationReason) throw new Error(JSON.stringify(result));
      await pty.ptyRemove(session.id);
    }
    console.log("CONPTY_CLEAN_EXIT");
  `;
  try {
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, RCMCP_STATE_DIR: root }, timeout: 25000, windowsHide: true,
    });
    expect(result.stdout).toContain("CONPTY_CLEAN_EXIT");
    expect(result.stderr).toBe("");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
