import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import { readWindowsIdentity, type WindowsTokenIdentity } from "./windows-identity.ts";
import process from "node:process";
import { stateRoot } from "./state.ts";

export type RuntimeContext = "system" | "user" | "desktop" | "unknown";
export type PrivilegeLevel = "root" | "system" | "admin" | "owner" | "user" | "unknown";

export const runtimeStartedAt = new Date().toISOString();
export const runtimeInstanceId = randomUUID();

function packageVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return parsed.version ?? null;
  } catch { return null; }
}

function repositoryRootFromMarkers(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function gitRuntimeSha(cwd = process.cwd()): string | null {
  if (process.env.RCMCP_RUNTIME_SHA) return process.env.RCMCP_RUNTIME_SHA;
  const repositoryRoot = repositoryRootFromMarkers(cwd);
  if (!repositoryRoot) return null;
  try {
    return execFileSync("git", ["-c", `safe.directory=${repositoryRoot}`, "rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 2000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch { return null; }
}

function detectContext(token: WindowsTokenIdentity | null): RuntimeContext {
  const configured = process.env.RCMCP_RUNTIME_CONTEXT;
  if (configured === "system" || configured === "user" || configured === "desktop") return configured;
  if (process.env.RCMCP_DESKTOP_ENABLED === "1") return "desktop";
  if (typeof process.getuid === "function") return process.getuid() === 0 ? "system" : "user";
  if (token?.isSystem) return "system";
  return "unknown";
}

function canElevate(admin: boolean): boolean {
  if (typeof process.getuid === "function") {
    if (process.getuid() === 0) return true;
    const probe = spawnSync("sudo", ["-n", "true"], { stdio: "ignore", timeout: 2000 });
    return probe.status === 0;
  }
  return admin;
}

function probeInteractiveSessionSync(): boolean {
  if (process.env.RCMCP_DESKTOP_ENABLED === "1") return true;
  if (process.platform === "win32") {
    const probe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[bool](Get-Process explorer -ErrorAction SilentlyContinue)"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    return probe.status === 0 && probe.stdout.trim().toLowerCase() === "true";
  }
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function privilegeLevel(admin: boolean, token: WindowsTokenIdentity | null): PrivilegeLevel {
  if (typeof process.getuid === "function" && process.getuid() === 0) return "root";
  if (token && !token.verified) return "unknown";
  if (token?.isSystem) return "system";
  if (admin) return "admin";
  return process.env.RCMCP_RUNTIME_CONTEXT === "user" || process.env.RCMCP_RUNTIME_CONTEXT === "desktop" ? "owner" : "user";
}

const version = packageVersion();
const sha = gitRuntimeSha();
const windowsIdentity = process.platform === "win32" ? readWindowsIdentity() : null;
const context = detectContext(windowsIdentity);
const actualUser = (() => { try { return windowsIdentity?.user ?? userInfo().username; } catch { return null; } })();
const desktopEnabled = process.env.RCMCP_DESKTOP_ENABLED === "1";
const admin = windowsIdentity?.isAdmin ?? false;
const elevationAvailable = canElevate(admin);
const privilege = privilegeLevel(admin, windowsIdentity);
let interactiveAvailable = probeInteractiveSessionSync();
let interactiveProbeInFlight = false;

function refreshInteractiveSessionAsync(): void {
  if (desktopEnabled) {
    interactiveAvailable = true;
    return;
  }
  if (process.platform !== "win32" || interactiveProbeInFlight) return;
  interactiveProbeInFlight = true;
  execFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[bool](Get-Process explorer -ErrorAction SilentlyContinue)"],
    { encoding: "utf8", timeout: 3000, windowsHide: true },
    (error, stdout) => {
      if (!error) interactiveAvailable = stdout.trim().toLowerCase() === "true";
      interactiveProbeInFlight = false;
    },
  );
}

if (process.platform === "win32" && !desktopEnabled) {
  refreshInteractiveSessionAsync();
  const interactiveRefreshTimer = setInterval(refreshInteractiveSessionAsync, 5000);
  interactiveRefreshTimer.unref();
}

const rgPath = process.env.RCMCP_RG_PATH ?? "rg";
const rgProbe = spawnSync(rgPath, ["--version"], { encoding: "utf8", timeout: 2000, windowsHide: true });
const searchReady = rgProbe.status === 0;

function stateReady(): boolean {
  try {
    mkdirSync(stateRoot, { recursive: true });
    accessSync(stateRoot, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch { return false; }
}

export function runtimeStatus() {
  const writableState = stateReady();
  const capabilities = [
    "power-requests", "wake-relay",
    "browser-sessions", "browser-dom", "browser-cdp",
    "exec", "filesystem", "process", "pty", "jobs", "service", "repo", "project", "docker",
    "metrics", "network", "storage", "gpu", "packages", "power",
    ...(searchReady ? ["search"] : []),
    "fs-edit", "repo-checkpoint-selection", "repo-apply-patch", "project-multistack", "deploy-phases", "job-follow",
    ...(desktopEnabled ? ["desktop", "desktop-session", "desktop-batch", "desktop-helper", "desktop-window-enumeration", "desktop-uia", "clipboard", "browser"] : []),
    ...(elevationAvailable ? ["elevation"] : []),
    ...(interactiveAvailable ? ["interactive-session"] : []),
  ];
  return {
    ready: writableState,
    instanceId: runtimeInstanceId,
    startedAt: runtimeStartedAt,
    pid: process.pid,
    context,
    version,
    sha,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    user: actualUser,
    accountName: windowsIdentity?.accountName ?? null,
    accountSid: windowsIdentity?.accountSid ?? null,
    processSessionId: windowsIdentity?.sessionId ?? null,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    ownerUser: process.env.RCMCP_OWNER_USER ?? null,
    privilege,
    elevationAvailable,
    interactiveSessionAvailable: interactiveAvailable,
    stateRoot,
    capabilities,
    checks: {
      state: { ready: writableState },
      search: { ready: searchReady, binary: rgPath },
      desktop: { ready: desktopEnabled, enabled: desktopEnabled, interactiveSessionAvailable: interactiveAvailable },
      identity: { privilege, ownerUser: process.env.RCMCP_OWNER_USER ?? null, elevationAvailable, verified: windowsIdentity?.verified ?? true, source: windowsIdentity ? "windows-token" : "posix", accountSid: windowsIdentity?.accountSid ?? null, ...(windowsIdentity?.error ? { error: windowsIdentity.error } : {}) },
    },
  };
}
