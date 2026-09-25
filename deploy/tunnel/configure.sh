#!/usr/bin/env bash
set -euo pipefail

TUNNEL_ID=${1:-}
RUNTIME_KEY_FILE=${2:-}
REPO=${3:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/remote-control-mcp
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/remote-control-mcp
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
SERVICE=remote-control-tunnel.service
BACKUP_ROOT="$STATE_DIR/tunnel-config-backups"
RUNTIME_SECRET="$CONFIG_DIR/openai-tunnel-runtime.key"
MCP_HEADER_SECRET="$CONFIG_DIR/mcp-authorization-header"
TUNNEL_ENV="$CONFIG_DIR/tunnel.env"
UNIT_FILE="$UNIT_DIR/$SERVICE"
SOURCE_UNIT="$REPO/deploy/tunnel/remote-control-tunnel.user.service"
CLIENT="$HOME/.local/bin/tunnel-client"
STARTUP_WAIT_SECONDS=${RCMCP_MCP_STARTUP_WAIT_SECONDS:-30}
[[ $STARTUP_WAIT_SECONDS =~ ^[1-9][0-9]*$ ]] || { echo "RCMCP_MCP_STARTUP_WAIT_SECONDS must be a positive integer" >&2; exit 2; }

usage() {
  echo "Usage: $0 tunnel_<32 lowercase hex> /path/to/runtime-key [repo]" >&2
}

[[ $TUNNEL_ID =~ ^tunnel_[0-9a-f]{32}$ ]] || { usage; exit 2; }
[[ -s $RUNTIME_KEY_FILE ]] || { echo "Runtime key file missing or empty: $RUNTIME_KEY_FILE" >&2; exit 2; }
[[ -x $CLIENT ]] || { echo "Missing $CLIENT" >&2; exit 2; }
[[ -r $REPO/.env.mcp ]] || { echo "Missing $REPO/.env.mcp" >&2; exit 2; }
[[ -r $SOURCE_UNIT ]] || { echo "Missing $SOURCE_UNIT" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "systemctl is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

TOKEN=$(sed -n 's/^RCMCP_MCP_TOKEN=//p' "$REPO/.env.mcp" | tail -1)
[[ -n $TOKEN ]] || { echo "RCMCP_MCP_TOKEN not found in $REPO/.env.mcp" >&2; exit 2; }

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$UNIT_DIR" "$BACKUP_ROOT"
chmod 700 "$CONFIG_DIR" "$STATE_DIR" "$BACKUP_ROOT"

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR=$(mktemp -d "$BACKUP_ROOT/${STAMP}.XXXXXX")
chmod 700 "$BACKUP_DIR"
STAGE_DIR=$(mktemp -d "$CONFIG_DIR/.configure.XXXXXX")
STAGE_UNIT=$(mktemp "$UNIT_DIR/.${SERVICE}.XXXXXX")
PREV_ENABLED=0
PREV_ACTIVE=0
systemctl --user is-enabled --quiet "$SERVICE" 2>/dev/null && PREV_ENABLED=1 || true
systemctl --user is-active --quiet "$SERVICE" 2>/dev/null && PREV_ACTIVE=1 || true

backup_one() {
  local src=$1 name=$2
  if [[ -e $src || -L $src ]]; then
    cp -a -- "$src" "$BACKUP_DIR/$name"
    printf '1\n' > "$BACKUP_DIR/had-$name"
  else
    printf '0\n' > "$BACKUP_DIR/had-$name"
  fi
}
backup_one "$RUNTIME_SECRET" runtime-key
backup_one "$MCP_HEADER_SECRET" mcp-header
backup_one "$TUNNEL_ENV" tunnel.env
backup_one "$UNIT_FILE" unit.service
printf '%s\n' "$PREV_ENABLED" > "$BACKUP_DIR/was-enabled"
printf '%s\n' "$PREV_ACTIVE" > "$BACKUP_DIR/was-active"
printf '%s\n' "$CONFIG_DIR" > "$BACKUP_DIR/config-dir"
printf '%s\n' "$UNIT_DIR" > "$BACKUP_DIR/unit-dir"

restore_one() {
  local dst=$1 name=$2
  if [[ $(cat "$BACKUP_DIR/had-$name") == 1 ]]; then cp -a -- "$BACKUP_DIR/$name" "$dst"; else rm -f -- "$dst"; fi
}
rollback() {
  local status=${1:-$?}
  trap - ERR INT TERM
  echo "Tunnel configure failed; rolling back from $BACKUP_DIR" >&2
  restore_one "$RUNTIME_SECRET" runtime-key
  restore_one "$MCP_HEADER_SECRET" mcp-header
  restore_one "$TUNNEL_ENV" tunnel.env
  restore_one "$UNIT_FILE" unit.service
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if [[ $PREV_ENABLED == 1 ]]; then systemctl --user enable "$SERVICE" >/dev/null 2>&1 || true; else systemctl --user disable "$SERVICE" >/dev/null 2>&1 || true; fi
  if [[ $PREV_ACTIVE == 1 ]]; then systemctl --user restart "$SERVICE" >/dev/null 2>&1 || true; else systemctl --user stop "$SERVICE" >/dev/null 2>&1 || true; fi
  rm -rf -- "$STAGE_DIR" "$STAGE_UNIT"
  exit "$status"
}
trap 'rollback $?' ERR INT TERM

install -m 600 "$RUNTIME_KEY_FILE" "$STAGE_DIR/openai-tunnel-runtime.key"
printf 'Bearer %s' "$TOKEN" > "$STAGE_DIR/mcp-authorization-header"
chmod 600 "$STAGE_DIR/mcp-authorization-header"
unset TOKEN
cat > "$STAGE_DIR/tunnel.env" <<ENV
CONTROL_PLANE_TUNNEL_ID=$TUNNEL_ID
MCP_SERVER_URL=http://127.0.0.1:45230/mcp
MCP_EXTRA_HEADERS=Authorization: file:$MCP_HEADER_SECRET
MCP_DISCOVERY_EXTRA_HEADERS=Authorization: file:$MCP_HEADER_SECRET
MCP_STARTUP_WAIT_TIMEOUT=${STARTUP_WAIT_SECONDS}s
HEALTH_LISTEN_ADDR=127.0.0.1:45233
LOG_LEVEL=info
LOG_FORMAT=json
ENV
chmod 600 "$STAGE_DIR/tunnel.env"
install -m 644 "$SOURCE_UNIT" "$STAGE_UNIT"

mv -f -- "$STAGE_DIR/openai-tunnel-runtime.key" "$RUNTIME_SECRET"
mv -f -- "$STAGE_DIR/mcp-authorization-header" "$MCP_HEADER_SECRET"
mv -f -- "$STAGE_DIR/tunnel.env" "$TUNNEL_ENV"
mv -f -- "$STAGE_UNIT" "$UNIT_FILE"
rmdir "$STAGE_DIR"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE" >/dev/null
systemctl --user restart "$SERVICE"

READY=0
READY_DEADLINE=$((SECONDS + STARTUP_WAIT_SECONDS))
while (( SECONDS < READY_DEADLINE )); do
  if curl -fsS --max-time 2 http://127.0.0.1:45233/healthz >/dev/null 2>&1 \
    && curl -fsS --max-time 2 http://127.0.0.1:45233/readyz >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done
if [[ $READY != 1 ]]; then
  echo "Tunnel failed health/readiness verification" >&2
  rollback 1
fi

trap - ERR INT TERM
printf '%s\n' "$BACKUP_DIR" > "$STATE_DIR/last-tunnel-config-backup"
printf '%s\n' "$TUNNEL_ID" > "$STATE_DIR/last-tunnel-id"
echo "Tunnel service configured and verified. Recovery backup: $BACKUP_DIR"
echo "Admin UI: http://127.0.0.1:45233/ui"
