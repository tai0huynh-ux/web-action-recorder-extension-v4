# Chromium Control Platform State

Updated: 2026-07-16

## Phase

Phase 1 - Browser Agent minimal container gate is complete on the Linux Docker host `root@192.168.1.201`.

Phase 2 - Chromium Control Native X11 Gate is complete.

Status: Complete.

## Linux Gate Environment

- Distro: Ubuntu 24.04.4 LTS (Noble Numbat).
- Kernel: Linux 6.8.0-124-generic.
- Architecture: x86_64.
- CPU: 4 cores.
- RAM: 15 GiB.
- Root filesystem free: 798 GiB.
- Docker Engine: 29.4.2.
- Docker Compose: v5.1.3.
- Host Node.js: v24.14.1.
- Host npm: 11.11.0.

## Source Sync

Source of truth remains the Windows repo:

`C:\Users\huynh cong thanh\Downloads\assistant-media\web-action-recorder-extension-v4`

The source was archived from Windows, excluding `node_modules`, `.git`, artifacts, profiles, temp files, and logs, then deployed to:

`/opt/war/web-action-recorder-extension-v4`

SHA-256 checks matched for:

- `package.json`
- `package-lock.json`
- `manifest.json`
- `platform/browser-agent/Dockerfile`
- `platform/container/compose.phase1.yml`
- `platform/browser-agent/src/browserController.js`
- `platform/browser-agent/src/browserSupervisor.js`

## Phase 1 Container

- Image: `war-browser-agent:phase1`.
- Image ID: `sha256:35518cfa30b89ce208407345f0917cb07897a63131d07f8c054b61fe8a064659`.
- Image size: 1.35 GB disk usage, 359 MB content size.
- Base image: `node:22-bookworm-slim`.
- Container architecture: amd64/linux.
- Container user: `war` (`uid=1001`), not root.
- Chromium: `150.0.7871.114` on Debian 12 bookworm.
- Container Node.js: `v22.23.1`.
- `playwright-core`: `1.61.1`.
- Xvfb readiness is checked with `xdpyinfo` before Agent start.
- `chromium-sandbox` is installed, but this Docker host rejects Chromium namespace sandboxing with `Operation not permitted`; smoke/Compose use explicit `WAR_BROWSER_NO_SANDBOX=1` and the Agent logs a warning.

## Implemented Fixes During Gate Closure

- Replaced the placeholder real Chromium integration test with a real Docker smoke test.
- Added a 100-iteration tab soak script.
- Added Xvfb readiness timeout in `docker-entrypoint.sh`.
- Added `chromium-sandbox` and `x11-utils` to the image.
- Added BrowserController stable tab registry:
  - generated `targetId`;
  - no URL fallback ID;
  - stable ID across navigation;
  - duplicate URLs get distinct IDs;
  - active tab tracked internally.
- Improved extension detection:
  - reads manifest;
  - detects extension/service-worker/page target;
  - reuses known extension ID if MV3 service worker is asleep;
  - opens `ui/sidepanel.html?standalone=1` to confirm the extension page loads.
- Remote/container API path now binds inside the container only with token and allowlist guards while host publish remains `127.0.0.1`.

## Verification

Baseline and final Linux verification:

- `npm run test:browser-agent:unit`: Pass, 38/38.
- `npm run check:browser-agent`: Pass.
- `npm run test:platform`: Pass; Phase 0 platform tests 22/22 and Browser Agent tests 38/38.
- `npm run check`: Pass.
- `npm run test:all`: Pass; extension tests 25/25, Phase 0 platform tests 22/22, Browser Agent tests 38/38.
- `npm run container:browser-agent:build`: Pass.
- `npm run container:browser-agent:smoke`: Pass.
- `npm run test:browser-agent:integration`: Pass, 1/1 real Chromium container smoke.
- `npm run test:browser-agent:soak`: Pass, 100 iterations.

Smoke evidence:

- Browser-ready time: 2317 ms.
- Extension loaded: true.
- Extension ID: `edoicfpldmlabgdalemfgflpldiijdmm`.
- Extension version: `0.1.0`.
- Browser state: running.
- Device ID persisted across container restart: yes.
- Fixture marker persisted through Chromium restart and container restart: `markerSeenCount=2`.
- Cleanup: smoke container not running after test.

Soak evidence:

- Iterations: 100.
- Average loop latency: 124 ms.
- p95 loop latency: 132 ms.
- Errors: 0.
- Timeouts: 0.
- Tab count before/after: 1 -> 1.
- Process count before/after: 12 -> 11.
- Memory before/after: 274.2 MiB -> 300.6 MiB.
- RSS before: node 149340 KB, Xvfb 77368 KB, Chromium 970712 KB.
- RSS after: node 164256 KB, Xvfb 78132 KB, Chromium 992740 KB.
- Cleanup: soak container not running after test.

## Security Posture

- Host port is published only on `127.0.0.1`.
- Container remote mode requires `WAR_AGENT_TOKEN` and `WAR_AGENT_ALLOW`.
- `/health` exposes only minimal state.

## Phase 2 - Chromium Control

Status: Complete. Phase 2 Native X11 Gate passed three consecutive Linux container performance runs.

Phase 2 added typed semantic DOM/page control and typed raw Chromium input. It intentionally did not add streaming, VNC/noVNC, Native Messaging, arbitrary JavaScript, generic CDP passthrough, shell execution, file transfer from Windows, clipboard sync, scheduler work, extension install management, or Phase 3 work.

New modules:

- `platform/browser-agent/src/semanticController.js`
- `platform/browser-agent/src/rawInputController.js`
- `platform/browser-agent/src/elementTarget.js`
- `platform/browser-agent/src/coordinateMapper.js`
- `platform/browser-agent/src/inputSafety.js`
- `platform/browser-agent/src/emergencyStop.js`
- `platform/browser-agent/src/screenshotController.js`
- `platform/browser-agent/src/artifactRegistry.js`

New command families:

- Semantic: `page.click`, `page.doubleClick`, `page.hover`, `page.focus`, `page.fill`, `page.type`, `page.press`, `page.selectOption`, `page.check`, `page.uncheck`, `page.scroll`, `page.waitFor`, `page.getElementState`, `page.listInteractiveElements`, `page.uploadFile`, `page.handleDialog`, `page.screenshot`.
- Raw: `input.mouseMove`, `input.mouseDown`, `input.mouseUp`, `input.click`, `input.wheel`, `input.keyDown`, `input.keyUp`, `input.insertText`, `input.shortcut`, `browser.focusWindow`, `browser.openInternalPage`.
- Safety: `input.stopAll`, `input.getState`.

Semantic target model:

```json
{ "selectorType": "css", "value": "#login", "strict": true }
```

Supported selector types are `css`, `text`, `role`, `label`, `placeholder`, `testId`, and limited `xpath`. JavaScript expressions and Playwright locator-code strings are rejected.

Raw backend:

- Viewport input uses Playwright/CDP mouse and keyboard APIs.
- Browser-space input defaults to `war-x11-inputd`, a persistent Xlib/XTest helper over `/run/war/x11-input.sock`.
- `WAR_X11_BACKEND=xdotool` is an explicit diagnostic fallback only and is not installed in the default runtime image.
- `browser.focusWindow` is implemented in the helper by locating the Chromium X11 window, raising it, and setting input focus.

Limits:

- `WAR_INPUT_MAX_QUEUE`
- `WAR_INPUT_MAX_TEXT_LENGTH`
- `WAR_INPUT_MAX_DURATION_MS`
- `WAR_INPUT_MAX_SCROLL_DELTA`
- `WAR_SEMANTIC_DEFAULT_TIMEOUT_MS`
- `WAR_SEMANTIC_MAX_TIMEOUT_MS`
- `WAR_SCREENSHOT_MAX_BYTES`

Latest Phase 2 evidence:

- Baseline commit: `e83ef8764fa26981ca1b8f3fe36d86c50a769f41` on `main`.
- `npm run check`: Pass on Linux after sync.
- `npm run test:all`: Pass, 123 tests verified on Linux after sync.
- `npm.cmd run check`: Pass on Windows after sync.
- `npm.cmd run test:all`: Pass, 123 tests verified on Windows after sync.
- `npm run container:browser-agent:build`: Pass.
- `npm run container:browser-agent:smoke`: Pass.
- `npm run container:browser-agent:phase2-smoke`: Pass.
- `npm run test:browser-agent:phase2-performance:measure`: Pass.
- `npm run test:browser-agent:phase2-performance:gate`: Pass, three consecutive runs.
- Chromium: `150.0.7871.114`.
- Extension ID/version: `edoicfpldmlabgdalemfgflpldiijdmm` / `0.1.0`.
- Artifact location: `/opt/war/phase2-gate-e83ef8764fa2-20260716001243/artifacts/browser-agent/`.
- Gate artifacts:
  - `phase2-performance-1784135858497.json`
  - `phase2-performance-1784135871335.json`
  - `phase2-performance-1784135884274.json`

Native X11 Gate results:

| Run | X11 click p95 | X11 keyDown p95 | X11 keyUp p95 | page.click p95 | stopAll outer |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 ms | 1 ms | 1 ms | 54 ms | 2 ms |
| 2 | 1 ms | 1 ms | 1 ms | 54 ms | 2 ms |
| 3 | 1 ms | 1 ms | 1 ms | 55 ms | 3 ms |

Security posture remains:

- `/v1/control` requires auth in remote/container mode.
- `/v1/state` requires auth in remote/container mode.
- CORS is not wildcard.
- Tokens are redacted from logs.
- No streaming, WebRTC, VNC, Windows app, Native Messaging, clipboard, file transfer, extension manager, arbitrary JavaScript, generic CDP passthrough, or remote shell API was added.

## Remaining Risk

The Docker host does not permit Chromium sandbox namespaces. Phase 1 passes only with explicit `WAR_BROWSER_NO_SANDBOX=1` in the container gate. This is documented and logged as a deployment risk.

## Next Step

Architecture consolidation contracts.
