#!/usr/bin/env bash
set -uo pipefail
CONFIG_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/remote-control-mcp
STATE_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/remote-control-mcp
SERVICE=remote-control-tunnel.service
CLIENT="$HOME/.local/bin/tunnel-client"
ENV_FILE="$CONFIG_DIR/tunnel.env"
RUNTIME_KEY="$CONFIG_DIR/openai-tunnel-runtime.key"
HEADER_FILE="$CONFIG_DIR/mcp-authorization-header"
FAILED=0

check_file() {
  local label=$1 file=$2
  if [[ -r $file && -s $file ]]; then echo "$label=ok"; else echo "$label=missing"; FAILED=1; fi
}

[[ -x $CLIENT ]] && echo "client=ok" || { echo "client=missing"; FAILED=1; }
check_file tunnel_env "$ENV_FILE"
check_file runtime_key "$RUNTIME_KEY"
check_file mcp_header "$HEADER_FILE"

export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
if systemctl --user is-enabled --quiet "$SERVICE" 2>/dev/null; then echo "service_enabled=ok"; else echo "service_enabled=no"; FAILED=1; fi
if systemctl --user is-active --quiet "$SERVICE" 2>/dev/null; then echo "service_active=ok"; else echo "service_active=no"; FAILED=1; fi
if curl -fsS --max-time 3 http://127.0.0.1:45233/healthz >/dev/null 2>&1; then echo "health=ok"; else echo "health=failed"; FAILED=1; fi
if curl -fsS --max-time 3 http://127.0.0.1:45233/readyz >/dev/null 2>&1; then echo "ready=ok"; else echo "ready=failed"; FAILED=1; fi

if [[ -r $ENV_FILE && -x $CLIENT ]]; then
  # systemd EnvironmentFile accepts values with spaces that are not safe to
  # source in Bash. Import NAME=value pairs literally without evaluation.
  while IFS='=' read -r key value; do
    [[ -n $key && $key != \#* ]] || continue
    export "$key=$value"
  done < "$ENV_FILE"
  if "$CLIENT" doctor --explain --control-plane.api-key "file:$RUNTIME_KEY" --health.listen-addr 127.0.0.1:0; then echo "client_doctor=ok"; else echo "client_doctor=failed"; FAILED=1; fi
else
  echo "client_doctor=skipped"
fi

if [[ -r $STATE_DIR/last-tunnel-config-backup ]]; then echo "last_backup=$(cat "$STATE_DIR/last-tunnel-config-backup")"; fi
exit "$FAILED"
