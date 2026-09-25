import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function executable(file: string, body: string) {
  await writeFile(file, body);
  await chmod(file, 0o755);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "rcmcp-tunnel-test-"));
  roots.push(root);
  const home = path.join(root, "home");
  const xdgConfig = path.join(root, "config");
  const xdgState = path.join(root, "state");
  const repo = path.join(root, "repo");
  const fakeBin = path.join(root, "bin");
  const systemdState = path.join(root, "systemd-state");
  await Promise.all([
    mkdir(path.join(home, ".local", "bin"), { recursive: true }),
    mkdir(path.join(repo, "deploy", "tunnel"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }), mkdir(systemdState, { recursive: true }),
  ]);
  await writeFile(path.join(repo, ".env.mcp"), "RCMCP_MCP_TOKEN=test-token\n");
  await writeFile(path.join(root, "runtime.key"), "runtime-secret\n");
  await cp(path.resolve("deploy/tunnel/remote-control-tunnel.user.service"), path.join(repo, "deploy", "tunnel", "remote-control-tunnel.user.service"));
  await executable(path.join(home, ".local", "bin", "tunnel-client"), `#!/usr/bin/env bash
if [[ "$1" == doctor ]]; then
  [[ "$*" == *"--control-plane.api-key file:"* ]] || { echo "missing-runtime-key-flag" >&2; exit 7; }
  case "$MCP_EXTRA_HEADERS" in "Authorization: file:"*) ;; *) echo "bad-header-env" >&2; exit 8 ;; esac
fi
echo tunnel-client-$1
exit \${FAKE_DOCTOR_EXIT:-0}
`);
  await executable(path.join(fakeBin, "systemctl"), `#!/usr/bin/env bash
set -e
state="$FAKE_SYSTEMD_STATE_DIR"
shift # --user
cmd=$1; shift
case "$cmd" in
  is-enabled) [[ -f "$state/enabled" ]] ;;
  is-active) [[ -f "$state/active" ]] ;;
  daemon-reload) exit 0 ;;
  enable) touch "$state/enabled" ;;
  disable) rm -f "$state/enabled" ;;
  restart|start) touch "$state/active" ;;
  stop) rm -f "$state/active" ;;
  *) echo "unexpected systemctl: $cmd $*" >&2; exit 2 ;;
esac
`);
  await executable(path.join(fakeBin, "curl"), `#!/usr/bin/env bash
case "$*" in
  *readyz*) [[ "\${FAKE_CURL_FAIL_READY:-0}" != 1 ]] || exit 22 ;;
esac
echo ok
`);
  await executable(path.join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  const env = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: xdgConfig, XDG_STATE_HOME: xdgState,
    FAKE_SYSTEMD_STATE_DIR: systemdState,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };
  return { root, home, xdgConfig, xdgState, repo, systemdState, env, runtimeKey: path.join(root, "runtime.key") };
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [path.resolve(script), ...args], { env, encoding: "utf8" });
}

describe.skipIf(process.platform === "win32")("tunnel configure recovery", () => {
  it("configures transactionally and supports explicit rollback to the previous empty state", async () => {
    const f = await fixture();
    const tunnelId = `tunnel_${"a".repeat(32)}`;
    const configured = run("deploy/tunnel/configure.sh", [tunnelId, f.runtimeKey, f.repo], f.env);
    expect(configured.status, configured.stderr).toBe(0);
    const configDir = path.join(f.xdgConfig, "remote-control-mcp");
    const stateDir = path.join(f.xdgState, "remote-control-mcp");
    expect(await readFile(path.join(configDir, "tunnel.env"), "utf8")).toContain(`CONTROL_PLANE_TUNNEL_ID=${tunnelId}`);
    expect((await stat(path.join(configDir, "openai-tunnel-runtime.key"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(configDir, "mcp-authorization-header"), "utf8")).toBe("Bearer test-token");
    expect(await stat(path.join(f.systemdState, "enabled"))).toBeTruthy();
    expect(await stat(path.join(f.systemdState, "active"))).toBeTruthy();
    const backup = (await readFile(path.join(stateDir, "last-tunnel-config-backup"), "utf8")).trim();
    const rolledBack = run("deploy/tunnel/rollback.sh", [backup], f.env);
    expect(rolledBack.status, rolledBack.stderr).toBe(0);
    await expect(stat(path.join(configDir, "tunnel.env"))).rejects.toThrow();
    await expect(stat(path.join(f.systemdState, "enabled"))).rejects.toThrow();
    await expect(stat(path.join(f.systemdState, "active"))).rejects.toThrow();
  });

  it("automatically restores the previous config and service state when readiness fails", async () => {
    const f = await fixture();
    const configDir = path.join(f.xdgConfig, "remote-control-mcp");
    const unitDir = path.join(f.xdgConfig, "systemd", "user");
    await mkdir(configDir, { recursive: true }); await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(configDir, "tunnel.env"), "OLD_ENV=1\n");
    await writeFile(path.join(configDir, "openai-tunnel-runtime.key"), "old-key\n");
    await writeFile(path.join(configDir, "mcp-authorization-header"), "old-header");
    await writeFile(path.join(unitDir, "remote-control-tunnel.service"), "old-unit\n");
    await writeFile(path.join(f.systemdState, "enabled"), ""); await writeFile(path.join(f.systemdState, "active"), "");
    const failed = run("deploy/tunnel/configure.sh", [`tunnel_${"b".repeat(32)}`, f.runtimeKey, f.repo], {
      ...f.env, FAKE_CURL_FAIL_READY: "1", RCMCP_MCP_STARTUP_WAIT_SECONDS: "1",
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("rolling back");
    expect(await readFile(path.join(configDir, "tunnel.env"), "utf8")).toBe("OLD_ENV=1\n");
    expect(await readFile(path.join(configDir, "openai-tunnel-runtime.key"), "utf8")).toBe("old-key\n");
    expect(await readFile(path.join(configDir, "mcp-authorization-header"), "utf8")).toBe("old-header");
    expect(await readFile(path.join(unitDir, "remote-control-tunnel.service"), "utf8")).toBe("old-unit\n");
    expect(await stat(path.join(f.systemdState, "enabled"))).toBeTruthy();
    expect(await stat(path.join(f.systemdState, "active"))).toBeTruthy();
  });

  it("uses one startup window for the tunnel client and readiness verification", async () => {
    const source = await readFile(path.resolve("deploy/tunnel/configure.sh"), "utf8");
    expect(source).toContain("STARTUP_WAIT_SECONDS=${RCMCP_MCP_STARTUP_WAIT_SECONDS:-30}");
    expect(source).toContain("MCP_STARTUP_WAIT_TIMEOUT=${STARTUP_WAIT_SECONDS}s");
    expect(source).toContain("READY_DEADLINE=$((SECONDS + STARTUP_WAIT_SECONDS))");
    expect(source).not.toContain("for _ in $(seq 1 30)");
  });

  it("doctor reports service/health/readiness and returns nonzero on a real failed check", async () => {
    const f = await fixture();
    const configured = run("deploy/tunnel/configure.sh", [`tunnel_${"c".repeat(32)}`, f.runtimeKey, f.repo], f.env);
    expect(configured.status, configured.stderr).toBe(0);
    const healthy = run("deploy/tunnel/doctor.sh", [], f.env);
    expect(healthy.status, healthy.stderr).toBe(0);
    expect(healthy.stdout).toContain("service_active=ok");
    expect(healthy.stdout).toContain("ready=ok");
    await rm(path.join(f.systemdState, "active"));
    const unhealthy = run("deploy/tunnel/doctor.sh", [], f.env);
    expect(unhealthy.status).toBe(1);
    expect(unhealthy.stdout).toContain("service_active=no");
  });
});
