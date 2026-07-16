# Chromium Control Platform State

Updated: 2026-07-16

## Phase

Phase 1 - Browser Agent minimal container gate is complete on the Linux Docker host `root@192.168.1.201`.

Phase 2 - Chromium Control Native X11 Gate is complete.

Status: Pairing Identity and Outbound Agent WSS Session complete locally.

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

Run Linux/container verification for the paired outbound Agent session path.

## Pairing Identity and Outbound Agent WSS Session

Updated: 2026-07-16

Status: Complete locally.

New modules:

- `platform/controller-core/src/pairingService.js`
- `platform/controller-core/src/sessionManager.js`
- `platform/controller-wss/src/serverAdapter.js`
- `platform/browser-agent/src/controllerSessionClient.js`

Architecture:

- Browser Agent remains the authoritative device identity.
- Agent connects outbound to Controller over WSS when configured.
- Controller Core owns pairing/session/job state; WSS is an adapter.
- Legacy HTTP Agent and Companion HTTP remain for diagnostics, compatibility, and tests.

Security posture:

- Pairing code and session credential plaintext are not persisted.
- Pending pairing requests have TTL and bounded collection size.
- Pairing must be explicitly confirmed or rejected.
- Revoke disables the paired credential; re-pair rotates it.
- WSS credentials are rejected in URLs and sent by connector header.
- Protocol version, malformed envelope, oversized payload, and stale session event are rejected.
- Reconnect delay has min/max and jitter; no zero-delay loop is used.

Latest local verification:

- `npm.cmd run check:controller-core`: Pass.
- `npm.cmd run test:controller-core`: Pass, 20/20.
- `npm.cmd run check:controller-wss`: Pass.
- `npm.cmd run test:controller-wss`: Pass, 2/2.
- `npm.cmd run check:browser-agent`: Pass.
- `npm.cmd run test:browser-agent:unit`: Pass, 85/85.

## Architecture Consolidation Contracts

Updated: 2026-07-16

Status: Complete.

Protocol:

- Added `war-control.v2` specialized runtime validator.
- Added AgentEnvelope, ControllerEnvelope, NativeBridgeEnvelope, AgentHello, DeviceDescriptor, PresenceEvent, DispatchPlan, DispatchAssignment, ExecutionJob, ExecutionEvent, PairingRequest, and PairingResult contracts.
- Validation rejects unknown message types, wrong protocol version, unknown top-level properties, oversized strings/arrays, invalid timestamps, invalid statuses, negative indexes/revisions, duplicate input definitions, sensitive plaintext defaults, missing mutating deadlines, and missing dispatch idempotency keys.

Adapters:

- Extension profile -> WorkflowRevision with deterministic content hash.
- WorkflowRevision -> Extension profile payload.
- Field array -> named input object by InputDefinition index.
- Companion command status -> unified ExecutionJob status.

Compatibility:

- Browser Agent remains authoritative device identity.
- Extension remains local workflow execution component.
- Extension graph runner remains primary workflow execution engine.
- Legacy Companion polling remains a compatibility path.
- Native Messaging and pairing are contract-only.
- No runtime behavior, transport, network listener, UI, remote video, clipboard, WebRTC, or Electron work was added.

Verification:

- Baseline before changes: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 123 tests.
- Focused tests: protocol 16/16, workflow-core 10/10, input-parser 23/23.
- Final acceptance: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 150 tests; `git diff --check` Pass with only LF/CRLF warnings.

## Native Messaging and Workflow Sync

Updated: 2026-07-16

Status: Complete. Windows local unit/browser checks pass, and Docker/container acceptance passed on Linux host `root@192.168.1.201`.

New platform modules:

- `native-host/framing.js`
- `native-host/host.js`
- `native-host/manifest.js`
- `native-host/install.js`
- `platform/browser-agent/src/localSocketServer.js`
- `platform/browser-agent/src/nativeBridgeHandler.js`
- `platform/browser-agent/src/workflowRegistry.js`
- `src/native-bridge.js`

Architecture:

- Extension connects to Native Host through Chrome Native Messaging.
- Native Host forwards Protocol v2 envelopes to Browser Agent over a private local socket.
- Browser Agent owns device identity and workflow registry.
- Extension graph runner remains the workflow execution engine.
- Legacy Companion polling remains a compatibility path behind `legacyCompanionPollingEnabled`.

Security posture:

- No public TCP listener was added.
- No WebRTC, Electron, clipboard, remote screen, arbitrary JavaScript, generic CDP, shell, or file-transfer surface was added.
- Native Host does not control Chromium directly.
- Large media/file payloads are excluded from Native Messaging.
- Workflow sync redacts sensitive typed values before persistence.

Verification added:

- Native framing tests cover encode/decode, partial header, partial payload, multiple messages, zero-length, oversized payload, invalid JSON, and socket forwarding.
- Browser Agent tests cover workflow registry revisioning/deduplication/recovery, socket permissions/path safety/payload limits, and bridge health/upload/list/get handling.
- Native bridge round-trip test covers `workflow.upload` and `execution.event` through the Native Host socket client and Agent socket handler.

Latest local verification:

- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 163 tests.
- `git diff --check`: Pass with LF/CRLF warnings only.
- `npm.cmd run test:browser:switch-tab:edge`: Pass on Edge 150.0.4078.65.
- `npm.cmd run container:browser-agent:build`: Blocked, `docker` is not recognized.
- `npm.cmd run test:browser-agent:integration`: Blocked, `spawn docker ENOENT`.
- Linux final exact-source path: `/opt/war/web-action-recorder-extension-v4-native-bridge-final-20260716012156`.
- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 163 tests.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass, artifact `smoke-1784139421378.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass, artifact `smoke-1784139437957.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:soak`: Pass, 100 iterations, average 131 ms, p95 137 ms, 0 errors, 0 timeouts, artifact `soak-1784139456020.json`.

## Controller Core Extraction

Updated: 2026-07-16

Status: Complete. Windows local checks pass, and Linux/container verification passed on `root@192.168.1.201`.

New modules:

- `platform/controller-core/src/controllerCore.js`
- `platform/controller-core/src/deviceRegistry.js`
- `platform/controller-core/src/workflowRegistry.js`
- `platform/controller-core/src/groupRegistry.js`
- `platform/controller-core/src/jobService.js`
- `platform/controller-core/src/executionEventStore.js`
- `platform/controller-core/src/authPolicy.js`
- `platform/controller-core/src/auditService.js`
- `platform/controller-core/src/persistenceAdapter.js`
- `platform/controller-core/src/stateTransitions.js`
- `platform/controller-core/src/datasetAssignment.js`

Compatibility:

- Companion HTTP remains the public compatibility surface.
- Route handlers parse/authenticate/map responses and call Controller Core.
- No WSS, Electron, WebRTC, Browser Agent HTTP, Native Bridge, X11, Extension runtime, or Dockerfile changes.

Verification:

- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 172 tests.
- Linux path: `/opt/war/web-action-recorder-extension-v4-controller-core-20260716013857`.
- Linux `npm ci`: Pass.
- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 172 tests.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass, artifact `smoke-1784140800752.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass, artifact `smoke-1784140817335.json`.

## Pairing Identity and Outbound Agent WSS Runtime Gate

Updated: 2026-07-16

Status: Complete. Linux WSS/TLS gate and Browser Agent container regression passed on `root@192.168.1.201`.

Environment:

- Ubuntu 24.04.4 LTS, kernel `6.8.0-124-generic`, x86_64.
- Node.js `v24.14.1`, npm `11.11.0`.
- Docker Engine `29.4.2`.
- Source deployment path: `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245`.

Source sync evidence:

- Exact working tree archive was copied from Windows source and extracted into the timestamped Linux path.
- SHA-256 was recorded for `package.json`, `package-lock.json`, `platform/controller-wss/src/wssServer.js`, `platform/browser-agent/src/controllerSessionClient.js`, `platform/controller-core/src/sessionManager.js`, `platform/controller-core/src/jobService.js`, `platform/controller-wss/integration/wssGate.js`, and `platform/browser-agent/Dockerfile`.
- `npm ci`: Pass.

TLS/WSS topology:

- Gate uses a temporary test CA and server certificate with SAN for `localhost`, `127.0.0.1`, and `controller-gate`.
- Controller WSS runtime is bound to an external HTTPS server and accepts only `/v1/agent-session`.
- Browser/client trust is provided by the temporary CA certificate.
- TLS verification stays enabled; no `NODE_TLS_REJECT_UNAUTHORIZED=0`, no `rejectUnauthorized=false`, and no curl `-k` evidence is used.
- Private keys exist only in the temporary gate directory and are cleaned up by the gate.

WSS scenarios verified:

- TLS verification succeeds with the test CA.
- Connection fails when the CA is not provided.
- Authorization header reaches the Controller runtime.
- Missing credential is rejected at upgrade.
- Invalid and revoked credentials receive authentication failure.
- Two Agents authenticate independently.
- Workflow reconciliation and dispatch create persisted command metadata.
- ControllerCore/process object restart plus reconnect replays the same non-terminal job.
- Replay preserves `jobId` and `idempotencyKey`.
- Terminal job does not replay.
- Duplicate reconnect timer guard is covered by focused unit tests and reported as `0` in the gate artifact.
- Runtime shutdown and temp key cleanup pass.

Verification:

- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 213 tests.
- Linux `npm run test:controller-session:wss-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198588905.json`.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `npm run container:browser-agent:controller-session-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198609263.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/browser-agent/smoke-1784198626814.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/browser-agent/smoke-1784198643920.json`.

Remaining deployment risk:

- The Docker host still rejects Chromium namespace sandboxing with `Operation not permitted`; container browser gates use explicit `WAR_BROWSER_NO_SANDBOX=1`. No sandbox support is claimed.
- The Browser Agent receives Controller dispatch over WSS, but this package intentionally does not add a new extension execution runner or protocol expansion for full workflow execution E2E.
