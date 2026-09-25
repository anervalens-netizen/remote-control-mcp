#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID} -ne 0 ]]; then exec sudo "$0" "$@"; fi
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=${1:-$(cd "$SCRIPT_DIR/../.." && pwd)}
NODE=${RCMCP_NODE_PATH:-$(command -v node)}
OWNER_USER=${RCMCP_OWNER_USER:-${SUDO_USER:-}}
if [[ -z $OWNER_USER || $OWNER_USER == root ]]; then OWNER_USER=$(stat -c %U "$REPO"); fi
if [[ ! -f "$REPO/.env.agent" ]]; then echo "Missing $REPO/.env.agent" >&2; exit 1; fi

# Promotion path: stop/disable the previous per-user host agent so port 45231
# can move cleanly to the root system service. Keep the central MCP/tunnel untouched.
if [[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]]; then
  uid=$(id -u "$SUDO_USER")
  runuser -u "$SUDO_USER" -- env XDG_RUNTIME_DIR="/run/user/$uid" \
    systemctl --user disable --now remote-control-agent.service >/dev/null 2>&1 || true
fi

cat > /etc/systemd/system/remote-control-agent.service <<UNIT
[Unit]
Description=Remote Control MCP root device agent
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env.agent
Environment=RCMCP_RUNTIME_CONTEXT=system
Environment=RCMCP_OWNER_USER=$OWNER_USER
ExecStart=$NODE $REPO/apps/agent/src/index.ts
Restart=always
RestartSec=2
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now remote-control-agent.service
systemctl restart remote-control-agent.service
systemctl --no-pager --full status remote-control-agent.service | sed -n '1,12p'
