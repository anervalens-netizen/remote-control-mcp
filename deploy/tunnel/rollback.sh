#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=${1:-}
[[ -n $BACKUP_DIR && -d $BACKUP_DIR ]] || { echo "Usage: $0 /path/to/tunnel-config-backup" >&2; exit 2; }
for required in config-dir unit-dir was-enabled was-active had-runtime-key had-mcp-header had-tunnel.env had-unit.service; do
  [[ -r $BACKUP_DIR/$required ]] || { echo "Invalid backup: missing $required" >&2; exit 2; }
done
CONFIG_DIR=$(cat "$BACKUP_DIR/config-dir")
UNIT_DIR=$(cat "$BACKUP_DIR/unit-dir")
SERVICE=remote-control-tunnel.service
RUNTIME_SECRET="$CONFIG_DIR/openai-tunnel-runtime.key"
MCP_HEADER_SECRET="$CONFIG_DIR/mcp-authorization-header"
TUNNEL_ENV="$CONFIG_DIR/tunnel.env"
UNIT_FILE="$UNIT_DIR/$SERVICE"

mkdir -p "$CONFIG_DIR" "$UNIT_DIR"
restore_one() {
  local dst=$1 name=$2
  if [[ $(cat "$BACKUP_DIR/had-$name") == 1 ]]; then cp -a -- "$BACKUP_DIR/$name" "$dst"; else rm -f -- "$dst"; fi
}
restore_one "$RUNTIME_SECRET" runtime-key
restore_one "$MCP_HEADER_SECRET" mcp-header
restore_one "$TUNNEL_ENV" tunnel.env
restore_one "$UNIT_FILE" unit.service

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
systemctl --user daemon-reload
if [[ $(cat "$BACKUP_DIR/was-enabled") == 1 ]]; then systemctl --user enable "$SERVICE" >/dev/null; else systemctl --user disable "$SERVICE" >/dev/null || true; fi
if [[ $(cat "$BACKUP_DIR/was-active") == 1 ]]; then systemctl --user restart "$SERVICE"; else systemctl --user stop "$SERVICE" >/dev/null || true; fi

echo "Tunnel configuration restored from $BACKUP_DIR"
