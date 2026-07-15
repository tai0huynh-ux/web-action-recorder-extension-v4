# ADR-0002: Persistent X11 Input Backend

Status: Accepted for Phase 2 implementation; gate validation still pending.

Date: 2026-07-15

## Context

Phase 2 browser-space input previously used `xdotool` through `execFile` for each command. Measurements showed raw X11 click p95 around 112 ms, above the required 80 ms gate. Stop behavior also needed a backend-level release path for held keys/buttons.

## Options

1. Persistent C helper using Xlib and XTest.
2. Persistent C helper using XCB and XTEST.
3. Per-command `xdotool`.

## Decision

Use a persistent C helper with Xlib and XTest.

Reasons:

- Reuses one `Display` connection.
- Avoids per-input process spawn.
- Uses typed commands only.
- Supports backend `releaseAll`.
- Keeps socket private to the container.
- Requires only small runtime libraries.

`xdotool` remains available only as an explicit diagnostic fallback through `WAR_X11_BACKEND=xdotool`; it is not the production default and must not be used to claim the performance gate.

## Protocol

Transport: Unix-domain socket at `/run/war/x11-input.sock`.

Framing: NDJSON with max line length 8192 bytes.

Allowed command types:

- `ping`
- `getState`
- `focusWindow`
- `mouseMove`
- `mouseDown`
- `mouseUp`
- `click`
- `wheel`
- `keyDown`
- `keyUp`
- `insertText`
- `shortcut`
- `releaseAll`

No shell, arbitrary keycode, arbitrary atom/property, raw X11, JavaScript, CDP passthrough, TCP, or UDP command exists.

## Lifecycle

The container entrypoint:

1. Starts Xvfb.
2. Waits for `xdpyinfo`.
3. Starts `war-x11-inputd` as user `war`.
4. Waits for the private socket.
5. Starts the Node Browser Agent.
6. On exit or signal, stops Node, then helper, then Xvfb.

The helper:

- Opens DISPLAY once.
- Requires XTEST.
- Creates/refuses socket path based on type and directory mode.
- Sets socket mode `0600`.
- Releases held key/button state on shutdown.
- Unlinks its socket on exit.

## Threat Model

The helper is not a command daemon. It accepts only a fixed protocol over a same-container Unix socket. The Browser Agent remains responsible for remote auth, IP allowlist, payload limits, and high-level command validation.

## Failure Behavior

Node command wrappers time out and return stable `AgentError` codes for connect, write, timeout, command failure, disconnect, and reconnect-limit failures. `input.stopAll` calls helper `releaseAll` with priority and then clears controller-held state.

## Benchmark Plan

The Phase 2 gate must measure native X11 click/key p95 inside a real container after warm-up, separate from browser startup. The gate target remains:

- X11 click p95 <= 80 ms.
- X11 key p95 <= 80 ms.
- Stop p95 <= 250 ms.

Three consecutive gate runs must pass before Phase 2 can be called Complete.
