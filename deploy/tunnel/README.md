# Secure MCP Tunnel

Runtime target: `http://127.0.0.1:45230/mcp`.

Prerequisites created in OpenAI Platform:
1. A tunnel associated with the intended ChatGPT workspace and Platform organization.
2. A Restricted Runtime API key whose principal has `Tunnels Read + Use`.

Install the official `tunnel-client` binary under `~/.local/bin/tunnel-client`, then run:

```bash
./deploy/tunnel/configure.sh tunnel_<32-lowercase-hex> /path/to/runtime-key
```

The configurator keeps the OpenAI key and local MCP bearer value out of git and argv. Configuration is transactional: it snapshots the current config/unit/service state, stages replacements, restarts the service, verifies health+readiness, and automatically rolls back if verification fails. Re-running the same command is the supported resume path. It enables `remote-control-tunnel.service`, with health/admin UI bound to `127.0.0.1:45233`.

Validation:

```bash
./deploy/tunnel/doctor.sh
curl -fsS http://127.0.0.1:45233/readyz
systemctl --user status remote-control-tunnel.service
```

In ChatGPT developer-mode plugin creation choose **Connection → Tunnel** and select/paste the same tunnel id.


Recovery:

```bash
# configure.sh prints and records the backup directory after every successful change
cat ~/.local/state/remote-control-mcp/last-tunnel-config-backup
./deploy/tunnel/rollback.sh /path/from/the-command-above
```

`doctor.sh` checks local config/secrets presence, systemd enabled/active state, tunnel health/readiness, then runs `tunnel-client doctor --explain`. It never prints secret contents.
