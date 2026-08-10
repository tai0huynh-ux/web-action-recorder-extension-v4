#!/usr/bin/env bash
set -Eeuo pipefail

: "${WAR_PILOT_ROLE:?WAR_PILOT_ROLE must be chrome or sunshine}"
: "${DISPLAY:?DISPLAY is required (for example :99)}"
: "${X11_SOCKET_DIR:=/tmp/.X11-unix}"
: "${WAR_PILOT_NO_SANDBOX:=0}"

if [[ ! "$DISPLAY" =~ ^:[0-9]+$ ]]; then
  echo "invalid DISPLAY '$DISPLAY'; expected :<number>" >&2
  exit 64
fi
if [[ "$X11_SOCKET_DIR" != /* || "$X11_SOCKET_DIR" == *$'\n'* ]]; then
  echo "invalid X11_SOCKET_DIR '$X11_SOCKET_DIR'" >&2
  exit 64
fi

PIDS=()
CLEANED_UP=0
cleanup() {
  [[ "$CLEANED_UP" == 1 ]] && return
  CLEANED_UP=1
  local index pid
  for ((index=${#PIDS[@]} - 1; index >= 0; index--)); do
    pid="${PIDS[$index]}"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

require_path() {
  local required="$1"
  [[ -e "$required" ]] || { echo "required path missing: $required" >&2; exit 66; }
}

wait_for_display() {
  local socket_path="$X11_SOCKET_DIR/X${DISPLAY#:}"
  local attempt
  for attempt in {1..100}; do
    if [[ -S "$socket_path" ]] && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "X11 display $DISPLAY did not become ready within 10 seconds" >&2
  return 70
}

run_chrome() {
  : "${CHROME_BIN:?CHROME_BIN is required for the chrome role}"
  require_path "$CHROME_BIN"
  command -v Xvfb >/dev/null 2>&1 || { echo "required command missing: Xvfb" >&2; exit 69; }
  command -v xdpyinfo >/dev/null 2>&1 || { echo "required command missing: xdpyinfo" >&2; exit 69; }
  : "${PROFILE_DIR:?PROFILE_DIR is required for the chrome role}"
  mkdir -p "$X11_SOCKET_DIR" "$PROFILE_DIR"
  chmod 0700 "$PROFILE_DIR"

  Xvfb "$DISPLAY" -screen 0 "${WIDTH:-1280}x${HEIGHT:-720}x24" -nolisten tcp &
  PIDS+=("$!")
  wait_for_display

  local -a chrome_args=(
    "--user-data-dir=$PROFILE_DIR"
    "--window-size=${WIDTH:-1280},${HEIGHT:-720}"
    --no-first-run --no-default-browser-check --disable-session-crashed-bubble
  )
  if [[ "$WAR_PILOT_NO_SANDBOX" == "1" ]]; then
    echo "WAR_PILOT_NO_SANDBOX=1: disposable pilot compatibility mode" >&2
    chrome_args+=(--no-sandbox)
  fi
  "$CHROME_BIN" "${chrome_args[@]}" about:blank &
  PIDS+=("$!")
  wait "${PIDS[-1]}"
}

run_sunshine() {
  : "${SUNSHINE_BIN:?SUNSHINE_BIN is required for the sunshine role}"
  : "${SUNSHINE_CONFIG:?SUNSHINE_CONFIG is required for the sunshine role}"
  require_path "$SUNSHINE_BIN"
  require_path "$SUNSHINE_CONFIG"
  command -v xdpyinfo >/dev/null 2>&1 || { echo "required command missing: xdpyinfo" >&2; exit 69; }
  wait_for_display

  "$SUNSHINE_BIN" "$SUNSHINE_CONFIG" &
  PIDS+=("$!")
  wait "${PIDS[-1]}"
}

case "$WAR_PILOT_ROLE" in
  chrome) run_chrome ;;
  sunshine) run_sunshine ;;
  *)
    echo "invalid WAR_PILOT_ROLE '$WAR_PILOT_ROLE'; expected chrome or sunshine" >&2
    exit 64
    ;;
esac
