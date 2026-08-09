#!/usr/bin/env bash
set -Eeuo pipefail

: "${DISPLAY:?DISPLAY is required (for example :99)}"
: "${CHROME_BIN:?CHROME_BIN is required}"
: "${SUNSHINE_BIN:?SUNSHINE_BIN is required}"
: "${SUNSHINE_CONFIG:?SUNSHINE_CONFIG is required}"
: "${PROFILE_DIR:?PROFILE_DIR is required}"
: "${WAR_PILOT_NO_SANDBOX:=0}"

if [[ ! "$DISPLAY" =~ ^:[0-9]+$ ]]; then
  echo "invalid DISPLAY '$DISPLAY'; expected :<number>" >&2
  exit 64
fi
for required in Xvfb xdpyinfo "$CHROME_BIN" "$SUNSHINE_BIN" "$SUNSHINE_CONFIG"; do
  if [[ "$required" == /* ]]; then
    [[ -e "$required" ]] || { echo "required path missing: $required" >&2; exit 66; }
  else
    command -v "$required" >/dev/null 2>&1 || { echo "required command missing: $required" >&2; exit 69; }
  fi
done
mkdir -p "$PROFILE_DIR"
chmod 0700 "$PROFILE_DIR"

PIDS=()
cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

Xvfb "$DISPLAY" -screen 0 "${WIDTH:-1280}x${HEIGHT:-720}x24" -nolisten tcp &
PIDS+=("$!")
for _ in {1..50}; do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo "Xvfb display $DISPLAY did not become ready" >&2; exit 70; }

"$SUNSHINE_BIN" "$SUNSHINE_CONFIG" &
PIDS+=("$!")
CHROME_ARGS=(
  "--user-data-dir=$PROFILE_DIR"
  "--window-size=${WIDTH:-1280},${HEIGHT:-720}"
  --no-first-run --no-default-browser-check --disable-session-crashed-bubble
)
if [[ "$WAR_PILOT_NO_SANDBOX" == "1" ]]; then
  echo "WAR_PILOT_NO_SANDBOX=1: disposable pilot compatibility mode" >&2
  CHROME_ARGS+=(--no-sandbox)
fi
"$CHROME_BIN" \
  "${CHROME_ARGS[@]}" \
  about:blank &
PIDS+=("$!")
wait "${PIDS[-1]}"
