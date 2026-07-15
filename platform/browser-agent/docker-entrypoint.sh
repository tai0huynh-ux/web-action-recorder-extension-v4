#!/bin/sh
set -eu

XVFB_WHD="${WAR_BROWSER_WIDTH:-1366}x${WAR_BROWSER_HEIGHT:-768}x24"
X11_INPUT_SOCKET="${WAR_X11_INPUT_SOCKET:-/run/war/x11-input.sock}"
Xvfb "${DISPLAY:-:99}" -screen 0 "$XVFB_WHD" -nolisten tcp &
XVFB_PID="$!"
X11_INPUT_PID=""
APP_PID=""

ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "Xvfb exited before display became ready" >&2
    exit 1
  fi
  if xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done

if [ "$ready" != "1" ]; then
  echo "Timed out waiting for Xvfb display ${DISPLAY:-:99}" >&2
  exit 1
fi

mkdir -p "$(dirname "$X11_INPUT_SOCKET")"
chmod 0700 "$(dirname "$X11_INPUT_SOCKET")"
war-x11-inputd "$X11_INPUT_SOCKET" &
X11_INPUT_PID="$!"

ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$X11_INPUT_PID" 2>/dev/null; then
    echo "war-x11-inputd exited before socket became ready" >&2
    exit 1
  fi
  if [ -S "$X11_INPUT_SOCKET" ]; then
    ready=1
    break
  fi
  sleep 0.1
done

if [ "$ready" != "1" ]; then
  echo "Timed out waiting for X11 input socket $X11_INPUT_SOCKET" >&2
  exit 1
fi

cleanup() {
  if [ -n "$APP_PID" ]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [ -n "$X11_INPUT_PID" ]; then
    kill "$X11_INPUT_PID" 2>/dev/null || true
    wait "$X11_INPUT_PID" 2>/dev/null || true
  fi
  kill "$XVFB_PID" 2>/dev/null || true
  wait "$XVFB_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

"$@" &
APP_PID="$!"
wait "$APP_PID"
