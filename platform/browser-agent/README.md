# Browser Agent Phase 1

Phase 1 adds one Linux container per Chromium endpoint:

- Browser Agent Node.js HTTP control server.
- Headed Chromium running on Xvfb.
- Persistent profile under `/data/chromium-profile`.
- The current unpacked Web Action Recorder extension copied to `/app/extension`.

There is no streaming, VNC, Native Messaging, Windows app, file transfer, clipboard, remote shell, arbitrary JavaScript, or CDP passthrough in this phase.

## Build

```powershell
npm.cmd run container:browser-agent:build
```

The Docker image installs system Chromium and uses `playwright-core`; Playwright browser downloads are disabled.

## Run One Node

```powershell
docker compose -f platform/container/compose.phase1.yml up --build browser-node
```

The host port bind is `127.0.0.1:3766`. Inside the container, Compose binds the Agent to `0.0.0.0` only with remote-mode guards enabled: `WAR_AGENT_TOKEN` and `WAR_AGENT_ALLOW` are required. The compose file uses `shm_size: 1gb`, a named `/data` volume, no privileged mode, no host networking, and no Docker socket mount.

## Data

The agent creates:

- `/data/device/identity.json`
- `/data/chromium-profile/`
- `/data/downloads/`
- `/data/logs/`

`identity.json` contains `schemaVersion`, `deviceId`, and `createdAt`. It is written once and reused across restarts.

## Configuration

Supported environment variables:

- `WAR_AGENT_HOST`
- `WAR_AGENT_PORT`
- `WAR_AGENT_TOKEN`
- `WAR_AGENT_ALLOW_REMOTE`
- `WAR_AGENT_ALLOW`
- `WAR_DATA_DIR`
- `WAR_CHROMIUM_EXECUTABLE`
- `WAR_EXTENSION_DIR`
- `WAR_BROWSER_HEADLESS`
- `WAR_BROWSER_NO_SANDBOX`
- `WAR_BROWSER_WIDTH`
- `WAR_BROWSER_HEIGHT`
- `WAR_BROWSER_LOCALE`
- `WAR_BROWSER_TIMEZONE`
- `WAR_AUTO_START_BROWSER`

Remote bind requires all of: `WAR_AGENT_ALLOW_REMOTE=1`, a `WAR_AGENT_TOKEN` of at least 24 characters, and explicit `WAR_AGENT_ALLOW` IPs. Tokens are never logged.

`WAR_BROWSER_NO_SANDBOX=1` remains an explicit diagnostic compatibility switch, but it is forbidden for managed-container, release, or MVP acceptance. The accepted runtime uses the non-root Chromium user-namespace sandbox with the reviewed AppArmor and seccomp policies; verify it with `npm run probe:chromium-sandbox-host` and the Container Real World Gate.

## API

- `GET /health`
- `GET /v1/state`
- `POST /v1/control`

All mutating commands go through `/v1/control` using the `war-control.v1` envelope.

Example:

```json
{
  "protocol": "war-control.v1",
  "messageId": "msg-1",
  "type": "tab.open",
  "deviceId": "DEVICE_ID",
  "timestamp": "2026-07-14T00:00:00.000Z",
  "deadlineMs": 60000,
  "idempotencyKey": "open-example-1",
  "payload": { "url": "https://example.com" }
}
```

Supported command types:

- `browser.getState`
- `browser.start`
- `browser.stop`
- `browser.restart`
- `tab.list`
- `tab.open`
- `tab.activate`
- `tab.navigate`
- `tab.close`

Only `http:` and `https:` URLs without credentials are accepted.

## Extension Status

Chromium starts with:

- `--disable-extensions-except=/app/extension`
- `--load-extension=/app/extension`

The agent reports `extension.loaded=true` only after detecting a `chrome-extension://` service worker target. If detection fails, health is degraded and the status includes `lastError`.

## Logs And Lifecycle

Logs are JSON lines on stdout. Use:

```powershell
docker compose -f platform/container/compose.phase1.yml logs -f browser-node
docker compose -f platform/container/compose.phase1.yml restart browser-node
docker compose -f platform/container/compose.phase1.yml down
```

The supervisor states are `stopped`, `starting`, `running`, `stopping`, `crashed`, and `degraded`. Auto restart is limited to three attempts in 60 seconds with backoff.

## Gate Tests

Run the non-Docker checks:

```powershell
npm.cmd run test:browser-agent:unit
npm.cmd run check:browser-agent
npm.cmd run test:all
```

Run the real container gate on a Docker Linux host:

```bash
npm run container:browser-agent:build
npm run container:browser-agent:smoke
npm run test:browser-agent:integration
npm run test:browser-agent:soak
```

The smoke and soak runners create a local HTTP fixture, start a temporary container with a named `/data` volume, publish the Agent only on host `127.0.0.1`, use a generated token plus Docker bridge allowlist, and remove the container/volume at the end. Artifacts are written under `artifacts/browser-agent/`.

Latest Phase 1 gate evidence:

- Chromium: `150.0.7871.114`.
- Extension ID/version: `edoicfpldmlabgdalemfgflpldiijdmm` / `0.1.0`.
- Browser-ready time: 2317 ms.
- Device ID persisted through container restart.
- Fixture marker persisted through Chromium restart and container restart.
- 100-tab soak: average 124 ms, p95 132 ms, 0 errors, 0 timeouts.

## Phase 2 Chromium Control

Status: Implemented but Gate Blocked.

Phase 2 extends `/v1/control` with typed semantic and raw browser commands. It still does not expose arbitrary JavaScript, generic CDP passthrough, shell execution, VNC/noVNC, WebRTC streaming, Native Messaging, clipboard sync, or Windows file transfer.

### Controller Live Control

The authenticated outbound Controller WSS session additionally supports `remote.control.request` / `remote.control.response`. The Agent can return a bounded JPEG viewport frame and execute the existing allowlisted raw-input commands, including pointer drag/wheel, regular typing, and `Ctrl+T`, `Ctrl+C`, and `Ctrl+V`. Multiple-container synchronization is performed by Controller fan-out with a shared `syncAt`; the Agent does not open another listener or expose generic CDP.

This is a lightweight LAN control path with selectable 1/3/6 FPS snapshots, not VNC, noVNC, WebRTC, full desktop capture, or bidirectional clipboard synchronization.

### Semantic Commands

- `page.click`
- `page.doubleClick`
- `page.hover`
- `page.focus`
- `page.fill`
- `page.type`
- `page.press`
- `page.selectOption`
- `page.check`
- `page.uncheck`
- `page.scroll`
- `page.waitFor`
- `page.getElementState`
- `page.listInteractiveElements`
- `page.uploadFile`
- `page.handleDialog`
- `page.screenshot`

Targets are structured data, not Playwright locator code:

```json
{
  "targetId": "tab-...",
  "target": {
    "selectorType": "css",
    "value": "#login",
    "strict": true
  }
}
```

Role target example:

```json
{
  "targetId": "tab-...",
  "target": {
    "selectorType": "role",
    "role": "button",
    "name": "Login",
    "exact": true
  }
}
```

Supported selector types: `css`, `text`, `role`, `label`, `placeholder`, `testId`, and limited `xpath`. JavaScript expressions and chained locator strings are rejected.

`page.uploadFile` only accepts `artifactId` values mapped to real files under `/data/uploads`. Client-supplied absolute paths, `../`, and symlink escapes are rejected. `page.screenshot` writes controlled artifacts under `/data/artifacts/screenshots`.

### Raw Input Commands

- `input.mouseMove`
- `input.mouseDown`
- `input.mouseUp`
- `input.click`
- `input.wheel`
- `input.keyDown`
- `input.keyUp`
- `input.insertText`
- `input.shortcut`
- `browser.focusWindow`
- `browser.openInternalPage`
- `input.stopAll`
- `input.getState`

Viewport-space input uses Playwright/CDP. Browser-space input defaults to the persistent native `war-x11-inputd` helper over `/run/war/x11-input.sock`.

The native helper:

- runs as user `war`;
- opens DISPLAY once;
- requires XTEST;
- exposes only a private Unix-domain socket;
- accepts typed NDJSON commands only;
- releases held keys/buttons on `input.stopAll` and shutdown.

`WAR_X11_BACKEND=xdotool` is retained only as an explicit diagnostic fallback and is not used for Phase 2 performance gate claims.

Allowed internal pages:

- `settings` -> `chrome://settings/`
- `extensions` -> `chrome://extensions/`
- `downloads` -> `chrome://downloads/`
- `version` -> `chrome://version/`
- `flags` -> `chrome://flags/`
- `extensionSidePanel` / `extensionPage` -> the Web Action Recorder extension page

Blocked by design: arbitrary `chrome://`, `chrome://crash/`, `chrome://kill/`, `chrome://hang/`, `chrome://quit/`, `devtools://`, `file://`, and `view-source:`.

### Limits

Additional fail-fast configuration:

- `WAR_INPUT_MAX_QUEUE`
- `WAR_INPUT_MAX_TEXT_LENGTH`
- `WAR_INPUT_MAX_DURATION_MS`
- `WAR_INPUT_MAX_SCROLL_DELTA`
- `WAR_SEMANTIC_DEFAULT_TIMEOUT_MS`
- `WAR_SEMANTIC_MAX_TIMEOUT_MS`
- `WAR_SCREENSHOT_MAX_BYTES`

Text entry, prompt text, form values, screenshot bytes, file contents, tokens, passwords, and secrets are not logged.

### Phase 2 Tests

```bash
npm run test:browser-agent:semantic
npm run test:browser-agent:input
npm run test:browser-agent:phase2-integration
npm run test:browser-agent:phase2-performance
npm run test:browser-agent:phase2-performance:measure
npm run test:browser-agent:phase2-performance:gate
npm run test:browser-agent:x11-native
npm run container:browser-agent:phase2-smoke
```

Latest evidence:

- Windows `npm.cmd run test:all`: Pass, 120 tests.
- Linux `npm run test:all`: Pass, 120 tests.
- `container:browser-agent:smoke`: Pass.
- `container:browser-agent:phase2-smoke`: Pass.
- Chromium: `150.0.7871.114`.
- Extension ID/version: `edoicfpldmlabgdalemfgflpldiijdmm` / `0.1.0`.
- Browser-ready time: 1795 ms.
- StopAll: 4 ms observed, held keys/buttons 0/0.
- Image before/after: `35518cfa30b8 1.35GB` -> `5810cb6e7b7f 1.35GB`.

Known gate blocker:

- Previous per-command `xdotool` raw X11 browser click p95 measured 112 ms, above the Phase 2 target of 80 ms. The native helper is now implemented, but Phase 2 is not marked Complete until Linux container performance passes three consecutive gate runs.
