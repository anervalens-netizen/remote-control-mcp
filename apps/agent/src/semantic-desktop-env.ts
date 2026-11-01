import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { semanticManifestSchema } from "../../../packages/protocol/src/semantic-desktop.ts";
import { runtimeEnv } from "./runtime-env.ts";

const run = promisify(execFile);
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function semanticManifestPath(): string {
  return process.env.RCMCP_AGENT_DESKTOP_MANIFEST ?? (process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), "RemoteControlMCP", "tools", "agent-desktop", "active.json")
    : path.join(os.homedir(), ".config", "remote-control-mcp", "agent-desktop.json"));
}
export function semanticDesktopConfigured(): boolean {
  return process.env.RCMCP_AGENT_DESKTOP_ENABLED !== "0" && existsSync(semanticManifestPath());
}
export function loadSemanticManifest() {
  const manifest = semanticManifestSchema.parse(JSON.parse(readFileSync(semanticManifestPath(), "utf8")));
  for (const item of [{ path: manifest.binary, sha256: manifest.sha256 }, ...manifest.files]) {
    if (!path.isAbsolute(item.path) || digest(readFileSync(item.path)) !== item.sha256) throw new Error("agent_desktop_integrity_mismatch");
  }
  return manifest;
}
const allowed = new Set(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"]);
function parseEnvironment(text: string): Record<string, string> {
  return Object.fromEntries(text.split("\n").map(line => { const n = line.indexOf("="); return [line.slice(0, n), line.slice(n + 1)]; }).filter(([key]) => allowed.has(key!)));
}
export async function semanticSession(requireGraphical = true) {
  const env = runtimeEnv();
  if (process.platform === "win32") {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$s=[Diagnostics.Process]::GetCurrentProcess().SessionId;$shell=Get-Process explorer -ErrorAction SilentlyContinue|Where-Object {$_.SessionId -eq $s}|Select-Object -First 1;@{session=$s;shellPid=$shell.Id;shellStarted=$(if($shell){$shell.StartTime.ToUniversalTime().Ticks}else{0})}|ConvertTo-Json -Compress"], { timeout: 4000, windowsHide: true });
    const identity = JSON.parse(stdout.trim());
    const session = identity.session;
    if (requireGraphical && (!Number.isInteger(session) || session <= 0)) throw new Error("graphical_session_unavailable");
    return { env, fingerprint: digest(`${os.hostname()}:${os.userInfo().username}:${JSON.stringify(identity)}`) };
  }
  if (process.platform !== "linux") throw new Error("semantic_desktop_platform_unsupported");
  const uid = process.getuid!();
  if (uid === 0) throw new Error("semantic_desktop_requires_owner_session");
  try {
    const { stdout: sessionId } = await run("loginctl", ["show-user", String(uid), "-p", "Display", "--value"], { timeout: 3000 });
    if (!sessionId.trim()) throw new Error("no graphical session");
    const { stdout: details } = await run("loginctl", ["show-session", sessionId.trim(), "-p", "Type", "-p", "Active", "-p", "User", "-p", "Leader", "-p", "TimestampMonotonic"], { timeout: 3000 });
    const values = Object.fromEntries(details.trim().split("\n").map(s => s.split("=")));
    if (values.User !== String(uid) || !["x11", "wayland"].includes(values.Type ?? "") || values.Active !== "yes") throw new Error("inactive graphical session");
    const { stdout } = await run("systemctl", ["--user", "show-environment"], { timeout: 3000, env: { ...env, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } });
    Object.assign(env, parseEnvironment(stdout));
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) throw new Error("display environment unavailable");
    return { env, fingerprint: digest(`${os.hostname()}:${uid}:${sessionId.trim()}:${details}:${JSON.stringify(parseEnvironment(stdout))}`) };
  } catch (error) {
    if (requireGraphical) throw new Error("graphical_session_unavailable", { cause: error });
    return { env, fingerprint: digest(`${os.hostname()}:${uid}:no-graphical-session`) };
  }
}
