# Project State - Web Action Recorder v4

Updated: 2026-07-16
Source of truth: `C:\Users\a\Documents\web-action-recorder-extension-v4`

## Current Status

Phase 1: Complete.

Phase 2: Complete with persistent native X11 backend; Native X11 Gate passed three consecutive Linux container performance runs.

Current Gate: Container Real-World Gate: PASS.

Current milestone: Container real-world execution hardening.

Next milestone: Physical two-machine LAN pilot.

Controller dispatch now reaches the real MV3 Extension through the Browser Agent, Native Messaging, and a generated temporary Windows native host executable shim on local Edge. The GitHub Container Real-World Gate now also passes with a real Browser Agent container, real Chromium, real MV3 Extension, TLS WSS Controller dispatch, Google search/copy workflow execution, result uplink, terminal replay protection, and cancel coverage. Deterministic unsigned development packaging builds the Electron Controller installer/portable package, Browser Agent bundle, MV3 Extension ZIP, release manifest, hashes, integrity scan, packaged smoke, and installer install/launch/uninstall gate. Production signing pipeline variables are implemented, but no production certificate was supplied in this run. Sensitive workflow inputs remain unsupported.

## Container Real-World Gate

Updated: 2026-07-17

Status: PASS. Decision: `READY_FOR_PHYSICAL_LAN_PILOT`.

Baseline before changes:

- HEAD: `62ad9a747d301312906fa42b96d551edada7e5be`.
- Branch: `main`.
- Failing GitHub Actions run: `29520410006`, timed out waiting for `job_started`.

Implemented:

- MV3 service worker now emits `job_started` at the tab execution boundary before terminal result delivery can race it.
- Service worker runtime initialization now starts Native Bridge polling when the worker starts, installs, or starts up.
- Browser Agent wakes Native Bridge polling after manifest installation, restarts Chromium once after a newly installed native host manifest, probes Native Messaging health, and records probe status in diagnostics.
- Container runtime now installs the Chromium Native Messaging host manifest under `/etc/chromium/native-messaging-hosts/com.web_action_recorder.native_bridge.json`.
- Native Host default socket path now follows `WAR_DATA_DIR` when `WAR_AGENT_SOCKET_PATH` is not supplied.
- Real-world container gate now writes sanitized evidence on failure, preserves event timelines, and asserts persisted `job_acknowledged`, `job_started`, `job_succeeded`, `startedBeforeTerminal`, and `sameJobIdThroughout`.
- GitHub evidence upload for the Container Real-World Gate runs with `if: always()`.

Verification:

- GitHub Actions Container Real-World Gate run `29525195037`: Pass, job `Controlled container search copy` completed in 1m05s.
- Artifact: `artifacts/container-real-world-gate-29525195037-download/container-real-world-gate-29525195037/`.
- Container gate evidence: Browser Agent container true, real Chromium true, MV3 Extension true, TLS WSS true, authenticated device true, controller dispatch true, workflow delivered true, Google case PASS, controlled fallback PASS, clipboard verification PASS, result uplink PASS, terminal replay protection PASS, cancel path PASS, cleanup PASS.
- Native Bridge probe: `ok=true`, `type=native.bridge.response`.
- Execution event sequence: `job_acknowledged` sequence 1, `job_started` sequence 2, `job_succeeded` sequence 3 for the same job id.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 290/290 tests.
- `npm.cmd run test:controller-session:wss-gate`: Pass, artifact `artifacts/controller-wss/wss-gate-1784227652567.json`.
- `npm.cmd run test:controller-extension:e2e`: Pass, artifact `artifacts/controller-extension-e2e/controller-extension-e2e-1784227654423.json`, event types `job_acknowledged`, `job_started`, `job_succeeded`.
- `npm.cmd run test:controller-electron:smoke`: Pass.
- `npm.cmd run test:release:integrity`: Pass, 79 artifacts checked.

Known limitations:

- Physical two-machine LAN pilot was not run in this checkpoint because no two physical machines were available. Status: `NOT_RUN_NO_PHYSICAL_MACHINES`.
- Production signing remains `BLOCKED_EXTERNAL_SIGNING_CREDENTIAL`.
- This checkpoint does not claim `READY_FOR_PERSONAL_LAN_USE`; it only closes the GitHub container gate and prepares the next physical LAN pilot.

## Production Packaging and Release Gate

Updated: 2026-07-17

Status: PASS for unsigned development package; production signed release is `BLOCKED_EXTERNAL_SIGNING_CREDENTIAL`.

Baseline before changes:

- HEAD: `31afda0e742ea8b00f77d1b59ae4f78e49099ba1`.
- Branch: `main`.
- Electron: `43.1.1`.

Implemented:

- `electron-builder@26.15.3` pinned exactly for Windows Electron packaging.
- Electron Builder config under `platform/controller-electron/release/` with ASAR enabled, Windows x64 NSIS and portable targets, deterministic artifact naming, explicit runtime file allowlist, and `ws` as the Controller runtime dependency.
- Packaged smoke mode for the real packaged executable, enabled only by `WAR_CONTROLLER_PACKAGED_SMOKE_OUTPUT`.
- Release scripts for `package:controller-electron`, `dist:controller-electron`, `package:browser-agent`, `package:extension`, `release:bundle`, `test:release:integrity`, `test:controller-electron:packaged`, and `test:release:gate`.
- Browser Agent ZIP sidecar with runtime source, `ws`, `playwright-core`, protocol files, MV3 runtime files, native-host JS runtime, and startup documentation.
- MV3 Extension deterministic ZIP with manifest at archive root and only extension runtime files.
- Native Messaging production install/uninstall helper now supports Windows HKCU browser registry keys without committing generated `.exe` shims or credentials.
- `release-manifest.json` and `SHA256SUMS.txt` generation for release artifacts.
- Integrity gate verifies hashes, tamper detection, and a minimal secret/path scan.
- Packaged Controller gate launches `win-unpacked`, verifies protocol/preload/seven views/security/state/WSS, installs the NSIS installer to a temp location, launches the installed executable, then uninstalls and verifies the installed executable is removed.

Verification:

- `npm.cmd run check:release`: Pass.
- `npm.cmd run check:controller-electron`: Pass.
- `npm.cmd run test:controller-electron:unit`: Pass, 77/77.
- `npm.cmd run test:release:integrity`: Pass.
- `npm.cmd run test:controller-electron:packaged`: Pass.
- `npm.cmd run test:release:gate`: Pass.

Known limitations:

- Generated `dist/` release artifacts are local-only and ignored.
- Production Authenticode signing was not executed because no certificate was supplied.
- Real-world Google remote-control acceptance is environment/external-service dependent and remains a manual acceptance follow-up after packaging gate.

## Controller-to-Extension Workflow Execution Downlink and E2E Gate

Updated: 2026-07-16

Status: Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS.

Baseline before changes:

- HEAD: `8f6e64cdaa00498364cb2db186eb8cd1b6a5c7c5`.
- Branch: `main`.

Implemented:

- Controller WSS dispatch now flows to Browser Agent `ControllerSessionClient`, through `NativeBridgeHandler`, into the MV3 service worker, and then into the existing Extension graph runner.
- Extension execution progress and terminal results are sent back through Native Messaging to Browser Agent and persisted by Controller Core as execution events/results.
- Controller-side cancel sends an `execution.cancel` downlink to the Extension runner and keeps replay/idempotency bounded after terminal jobs.
- Browser Agent and Extension completed-job caches are bounded to avoid unbounded replay/deduplication growth.
- Electron runtime invalidates Jobs when WSS execution results arrive so the UI can refresh persisted execution state.
- Windows Edge E2E uses a generated temporary `war-native-host-shim.exe` compiled from `platform/controller-wss/integration/windows-native-host-shim.cs`; no native binary is committed.
- The shim has no protocol logic. It validates a three-line config beside the executable, launches Node directly with `UseShellExecute=false`, forwards binary stdin/stdout/stderr, and keeps stdout reserved for Native Messaging frames.
- The Edge Native Messaging HKCU registry key is created only for the gate and removed during cleanup.

Verification:

- `npm.cmd run check:browser-agent`: Pass.
- `npm.cmd run test:browser-agent:unit`: Pass, 91/91.
- `npm.cmd run check:controller-wss`: Pass.
- `npm.cmd run test:controller-wss`: Pass, 14/14.
- `npm.cmd run check:controller-electron`: Pass.
- `npm.cmd run test:controller-electron:unit`: Pass, 58/58.
- `npm.cmd run test:controller-session:wss-gate`: Pass, artifact `artifacts/controller-wss/wss-gate-1784217821941.json` (local, redacted, not committed).
- `npm.cmd run test:controller-extension:e2e`: Pass on Edge `Edg/150.0.4078.65`, artifact `artifacts/controller-extension-e2e/controller-extension-e2e-1784217823686.json` (local, redacted, not committed).

E2E artifact highlights:

- TLS verified: true.
- Real Browser Agent: true.
- Real Chromium/Edge: true.
- Real MV3 Extension: true.
- Workflow executed: true.
- Result persisted: true.
- Execution events: `job_acknowledged`, `job_started`, `job_succeeded`.
- Cancel case: true.
- Replay after terminal count: 0.
- Cleanup: true.

Known limitations:

- The accepted browser path is local Edge MV3. Chrome can still be blocked by local policy or automation restrictions around `--load-extension`.
- The Windows executable shim is generated in a temporary directory during the gate; production packaging/signing is still a later milestone.
- Sensitive workflow inputs remain blocked.

## Secure Electron Controller Shell

Updated: 2026-07-16

Status: Accepted locally.

Baseline before changes:

- HEAD: `b282279655b09a1c214e3523b657366213d3940b`.
- Branch: `main`.
- Electron: `43.1.1`.

Implemented:

- Functional plain HTML/CSS/ES module renderer under `platform/controller-electron/renderer/`.
- Overview, Pairing, Devices, Groups, Workflows, Jobs, and Diagnostics sections.
- One-time pairing credential handling with no storage persistence and clear-on-view-change behavior.
- Sanitized device, pairing, workflow, job, and diagnostics rendering.
- Groups CRUD and device membership controls.
- Workflow JSON import and safe revision/profile payload rendering.
- Single-device dispatch form that does not accept main-owned dispatch fields.
- Controller-side cancel and separate persisted/transport/execution status display.
- Strict renderer CSP aligned with `appProtocol.js`.
- Renderer production safety scanner.
- Expanded real Electron smoke using Electron `43.1.1`, temporary userData/state, window security checks, renderer isolation checks, CSP checks, navigation/window/permission checks, trusted IPC, untrusted IPC denial, persistence restart, pairing sanitization, dispatch rejection checks, and natural cleanup.

Docs added:

- `docs/ADR-0007-secure-electron-controller-shell.md`
- `docs/ELECTRON_CONTROLLER.md`

Verification:

- `npm.cmd run check:controller-electron`: Pass.
- `npm.cmd run test:controller-electron:unit`: Pass, 58/58.
- `npm.cmd run test:controller-electron:smoke`: Pass, artifact under `artifacts/controller-electron/` local only.
- Linux/container WSS regression was not rerun for this checkpoint because production Controller WSS and Browser Agent behavior were not changed.

## Pairing Identity and Outbound Agent WSS Session

Updated: 2026-07-16

Status: Runtime gate closed. Windows local checks, real WSS/TLS gate, Linux WSS gate, and Linux container regression pass.

Baseline before changes:

- HEAD: `8048a675524a1cc5da7d50424abffe3bc1cade7b`.
- Branch: `main`.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 172 tests.

Implemented:

- Controller Core `PairingService` with one-time code, TTL, entropy from `crypto.randomBytes`, device identity binding, explicit confirm/reject, revoke and re-pair, replay rejection, pending-pairing limit, expiry cleanup, structured audit, and no plaintext pairing token or credential persistence.
- Controller Core `SessionManager` with paired credential authentication, `AgentHello`, presence, heartbeat timeout, online/offline/degraded/reconnecting states, generation-based duplicate session replacement, workflow metadata reconciliation, dispatch, acknowledgement/result handling, cancel, reconnect replay for non-terminal jobs, idempotency ledger, stale-session rejection, and shutdown cleanup.
- Transport adapter under `platform/controller-wss/src/serverAdapter.js` that calls Controller Core through domain APIs and validates Protocol v2 envelopes without adding transport logic to Controller Core.
- Browser Agent outbound `ControllerSessionClient` with `wss://` URL enforcement, credential-not-in-URL guard, header-based credential transport, bounded pending request map, bounded outbound queue, exponential reconnect backoff with jitter and min/max delay, Agent restart/controller restart handling, replay dispatch handling, graceful shutdown, and timer cleanup.
- Browser Agent product config gates for `WAR_CONTROLLER_WSS_URL` and `WAR_CONTROLLER_SESSION_CREDENTIAL`; no public Agent listener was added.

Runtime hardening closure on 2026-07-16:

- Baseline commit `0392fab0f5d20954787c411d4f5fbe4b4da4ec5f` was verified before changes.
- Root causes reproduced: Node global `WebSocket` did not deliver Authorization headers to a real upgrade request; process-restart replay was empty because replay depended on transient `session.pendingJobs`; socket `error` plus `close` could schedule duplicate reconnect timers and stale old-socket events could move a new socket back to reconnecting; pairing/session secret digests used direct string equality.
- Added dependency `ws` as the runtime WebSocket implementation for authenticated opening headers and real server wrapper support.
- Added `platform/controller-wss/src/wssServer.js` runtime wrapper over an external HTTP/HTTPS server. It enforces `/v1/agent-session`, parses a single Bearer Authorization header, rejects malformed/missing credentials, uses `ws` max payload handling, and delegates to `ControllerWssServerAdapter`.
- Browser Agent connector now uses `ws`, keeps credentials out of URL/subprotocol/logs, preserves `wss://` enforcement, supports internal CA injection for tests, normalizes string/Buffer/ArrayBuffer messages, and keeps TLS verification enabled.
- Dispatch metadata is persisted on the command as `dispatchMetadata` so persistent command state is the replay source of truth. `session.pendingJobs` remains only a transient cache rebuilt from persisted non-terminal commands.
- Dispatch idempotency survives ControllerCore object restart by returning the same persisted command metadata for duplicate `idempotencyKey`.
- Reconnect lifecycle now ignores stale socket events and schedules at most one reconnect timer per active socket close path.
- Pairing code and session credential digest comparison now uses `crypto.timingSafeEqual` through a malformed-safe digest helper.
- Agent execution-path decision: full graph execution is not connected in this package because the existing NativeBridge handler has execution event/result intake but no scoped typed `execution.dispatch` downlink without expanding protocol/runner scope. Gate remains at transport/session/job-state level.

Docs added:

- `docs/ADR-0006-pairing-and-outbound-agent-wss-session.md`

Verification:

- `npm.cmd run check:controller-core`: Pass.
- `npm.cmd run test:controller-core`: Pass, 20/20.
- `npm.cmd run check:controller-wss`: Pass.
- `npm.cmd run test:controller-wss`: Pass, 2/2.
- `npm.cmd run check:browser-agent`: Pass.
- `npm.cmd run test:browser-agent:unit`: Pass, 85/85.
- `npm.cmd run test:controller-session:wss-gate`: Pass, artifact `artifacts/controller-wss/wss-gate-1784198499411.json` (local, redacted, not committed).
- Linux source path: `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245`.
- Linux environment: Ubuntu 24.04.4 LTS, kernel `6.8.0-124-generic`, x86_64, Node.js `v24.14.1`, npm `11.11.0`, Docker `29.4.2`.
- Linux `npm ci`: Pass.
- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 195 tests.
- Linux `npm run test:controller-session:wss-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198588905.json`.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `npm run container:browser-agent:controller-session-gate`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/controller-wss/wss-gate-1784198609263.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/browser-agent/smoke-1784198626814.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass, artifact `/opt/war/web-action-recorder-extension-v4-wss-runtime-20260716104245/artifacts/browser-agent/smoke-1784198643920.json`.

## Architecture Consolidation Contracts

Updated: 2026-07-16

Status: Complete.

Scope:

- Added protocol v2 contract validation and pure adapters only.
- No Extension recorder/replayer runtime behavior changed.
- No Companion HTTP or scheduler runtime behavior changed.
- No Browser Agent HTTP runtime behavior changed.
- No Electron, Native Messaging runtime, WebSocket/WSS, WebRTC, remote video, clipboard, new network listener, or UI was added.

Contracts added:

- DeviceDescriptor, DeviceCapability, PresenceEvent.
- WorkflowRevision and InputDefinition.
- DispatchPlan and DispatchAssignment.
- ExecutionJob and ExecutionEvent.
- AgentHello.
- AgentEnvelope, ControllerEnvelope, NativeBridgeEnvelope.
- PairingRequest and PairingResult.

Adapters added:

- Extension profile -> WorkflowRevision.
- WorkflowRevision -> Extension profile.
- Input parser fields -> named input object.
- Companion command status -> unified ExecutionJob status.

Docs added:

- `docs/ADR-0003-endpoint-authority-and-extension-bridge.md`
- `docs/PROTOCOL_V2.md`
- `docs/PROJECT_MEMORY.md`

Verification:

- Baseline before changes: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 123 tests.
- Focused contract tests: `npm.cmd run test:platform:protocol` Pass, 16/16; `npm.cmd run test:platform:workflow-core` Pass, 10/10; `npm.cmd run test:platform:input-parser` Pass, 23/23.
- Final acceptance: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 150 tests; `git diff --check` Pass with only LF/CRLF warnings.

## Native Messaging and Workflow Sync

Updated: 2026-07-16

Status: Complete. Windows local unit/browser checks pass, and Docker/container acceptance passed on Linux host `root@192.168.1.201`.

Baseline before changes:

- HEAD: `148cdd8fe8e358ac0798d009d21ca044fafde69a`.
- Branch: `main`.
- Remote: `https://github.com/tai0huynh-ux/web-action-recorder-extension-v4.git`.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 150 tests.
- Architecture Consolidation Contracts: Complete.

Implemented:

- Chrome Native Messaging binary framing under `native-host/framing.js`.
- Small Native Host bridge under `native-host/host.js`; stdout is framed protocol response only, stderr is structured logging.
- Native Host manifest creation, install, and uninstall helpers under `native-host/manifest.js` and `native-host/install.js`.
- Browser Agent private local socket under `platform/browser-agent/src/localSocketServer.js`; Linux Unix socket path is configurable with `WAR_AGENT_SOCKET_PATH`.
- Browser Agent workflow registry under `platform/browser-agent/src/workflowRegistry.js` with atomic JSON persistence, corrupt-file recovery, contentHash deduplication, count and payload limits.
- Native bridge message handler under `platform/browser-agent/src/nativeBridgeHandler.js`.
- Extension bridge client under `src/native-bridge.js` with connection states, pending request limit, request timeout, correlation IDs, duplicate response protection, disconnect cleanup, and deterministic WorkflowRevision sync.
- `manifest.json` now includes only the added `nativeMessaging` permission; host permissions and content script matches were not expanded.
- `legacyCompanionPollingEnabled` defaults to true and gates the existing Companion alarm path without removing legacy code.

Message types added to Protocol v2:

- Extension to Agent: `bridge.hello`, `bridge.health`, `workflow.upload`, `workflow.list`, `workflow.get`, `execution.event`, `execution.result`, `execution.cancelled`, `emergency.stop.ack`.
- Agent to Extension: `bridge.welcome`, `bridge.health.request`, `workflow.upload.result`, `workflow.list.result`, `workflow.get.result`, `execution.dispatch`, `execution.cancel`, `emergency.stop`.

Workflow sync behavior:

- Profile save remains local-first.
- WorkflowRevision is sanitized and hashed deterministically before upload.
- Same `workflowId` plus `contentHash` returns the existing Agent revision.
- Agent-offline sync records pending metadata and does not block local save.

Execution lifecycle:

- Dispatch, execution event/result, cancel, and emergency stop message contracts are accepted through NativeBridgeEnvelope.
- Full graph execution still belongs to the Extension runner; Browser Agent does not create a second workflow runner.

Compatibility:

- Legacy Companion polling stays enabled by default for existing installs.
- Native Bridge does not auto-enable legacy polling.
- Control path is documented as `legacy_companion` or `native_bridge`.

Docs added:

- `docs/ADR-0004-native-messaging-and-workflow-sync.md`
- `docs/NATIVE_MESSAGING.md`

## Controller Core Extraction

Updated: 2026-07-16

Status: Complete. Windows local checks pass, and Linux/container verification passed on `root@192.168.1.201`.

Baseline:

- HEAD: `fbc4119f307e3dd4735b72d22073639fecbbb6ee`.
- Branch: `main`.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 163 tests.

Implemented:

- Extracted Controller Core under `platform/controller-core/`.
- Companion HTTP now acts as compatibility adapter over Controller Core.
- Added DeviceRegistry, WorkflowRegistry, GroupRegistry, JobService, ExecutionEventStore, AuthPolicy, AuditService, PersistenceAdapter, dataset assignment helper, and unified state transition rules.
- Kept Companion paths, request/response shapes, token behavior, allowlist behavior, and dashboard behavior.
- Kept legacy `leased` as compatibility status only; unified core state maps it to `dispatched`.
- JSON persistence now carries controller migration metadata, backs up before migration, and surfaces corrupt store files instead of silently resetting.
- No WSS, Electron, WebRTC, Browser Agent behavior, Extension runtime, Native Messaging runtime, or Dockerfile changes.

Docs added:

- `docs/ADR-0005-controller-core-extraction.md`
- `docs/CONTROLLER_CORE.md`

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

Verification on 2026-07-16:

- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass, 163 tests.
- `git diff --check`: Pass with LF/CRLF warnings only.
- `npm.cmd run test:browser:switch-tab:edge`: Pass on Edge 150.0.4078.65.
- `npm.cmd run container:browser-agent:build`: Blocked, `docker` is not recognized.
- `npm.cmd run test:browser-agent:integration`: Blocked, `spawn docker ENOENT`.
- Linux final exact-source path: `/opt/war/web-action-recorder-extension-v4-native-bridge-final-20260716012156`.
- Linux `npm ci`: Pass.
- Linux `npm run check`: Pass.
- Linux `npm run test:all`: Pass, 163 tests.
- Linux `npm run container:browser-agent:build`: Pass.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run container:browser-agent:smoke`: Pass, artifact `smoke-1784139421378.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:integration`: Pass, artifact `smoke-1784139437957.json`.
- Linux `WAR_BROWSER_NO_SANDBOX=1 npm run test:browser-agent:soak`: Pass, 100 iterations, average 131 ms, p95 137 ms, 0 errors, 0 timeouts, artifact `soak-1784139456020.json`.

Commit status:

- Ready to commit and push.

## Current MVP Status

Implemented MVP code path:

- Editor: larger/selectable ports, Enter/Space port selection, Escape cancel, link drop via `elementsFromPoint`, rAF-batched link redraw, standalone editor window, resizable canvas, derived root-node discovery/highlighting with `Gốc` badges.
- Picker/cursor: candidate chooser, preview/accept/cancel flow, draggable chooser, rAF-batched hover target box, high-contrast target border.
- Runner: graph validation before run, derived roots sent as explicit `startIds`, sequential multi-root execution in profile order, same-tab navigation continuation with explicit continuation ids, Switch Tab wildcard matching and continuation handoff to the matched web tab, `{{field}}` template inputs, abort-aware selector wait/delay, enabled-profile guard for remote commands.
- Companion Hub: admin token, enrollment token, per-device token, IP allowlist, LAN opt-in guard, device enroll/register/heartbeat, per-device command queue, lease/ack/result, batch creation, dataset assignment, JSON persistence, and a small web dashboard at `/dashboard`.
- Tests: unit tests for graph/template/scheduler/shared logic and integration test for two-device Companion queue isolation.

## Verification

Last verified on 2026-07-14:

- `npm run check`: Pass
- `npm test`: Pass, 25/25
- `npm run test:all`: Pass
- `npm run test:browser:switch-tab:edge`: Pass. Edge 150.0.4078.65 executed switch-tab handoff from `http://127.0.0.1:59305/source-site/source-page` to `http://127.0.0.1:59305/target-site/special-path`; latest artifact trace printed under `%TEMP%\war-browser-mv3-artifacts\2026-07-14T09-37-30-706Z-switch-tab\trace.json`.

Phase 0 Chromium Control Platform verification on 2026-07-14:

- Baseline before changes:
  - `npm run check`: blocked by PowerShell execution policy for `npm.ps1`; rerun as `npm.cmd run check`: Pass.
  - `npm run test:all`: blocked by PowerShell execution policy for `npm.ps1`; rerun as `npm.cmd run test:all`: Pass, 25/25.
- After changes:
  - `npm.cmd run test:platform:input-parser`: Pass, 16/16.
  - `npm.cmd run test:platform:protocol`: Pass, 3/3.
  - `npm.cmd run test:platform:workflow-core`: Pass, 3/3.
  - `npm.cmd run check`: Pass.
  - `npm.cmd run test:all`: Pass; extension tests 25/25 and platform tests 22/22.
- `CHROMIUM_CONTROL_PLATFORM_CODEX_PLAN.md` was not present at the source root and was not found by exact filename under `C:\Users`; Phase 0 followed the user-provided checklist.
- No Browser Agent, streaming, Windows app, Native Messaging, arbitrary JavaScript, remote shell, or public listener code was started.

Manual MVP acceptance attempt on 2026-07-14:

- Chrome 150.0.7871.115 and Edge 150.0.4078.65 were present.
- Browser unpacked-extension acceptance was blocked in this automation environment: command-line `--load-extension` ignored both this extension and a minimal control MV3 extension; `chrome://extensions` Developer mode controls were visible, but the native "Load unpacked" folder picker was not exposed to automation and no unpacked extension was loaded.
- Companion Hub API acceptance passed with two enrolled device records: enrollment, heartbeat, profile registration, per-device command isolation, batch result reporting, and stop-batch cancellation.
- At that checkpoint, real Chrome/Edge extension UI, picker, recorder, runner, and real browser-endpoint Companion polling were still pending until the extension could be manually loaded in a controllable browser session. Later Edge MV3 harnesses and the Controller-to-Extension E2E gate closed the Edge runner path.

Browser MV3 regression harness added on 2026-07-14:

- Framework selected: dependency-free Chrome DevTools Protocol from Node, so the harness does not require Playwright/Puppeteer or browser downloads.
- New command `npm run test:browser` defaults to installed Chrome; `npm run test:browser:chrome`, `npm run test:browser:edge`, and `WAR_BROWSER_PATH` are supported.
- Harness creates a temporary browser profile outside the source tree, loads the unpacked extension with `--load-extension`, detects the MV3 service worker/extension target, opens `ui/sidepanel.html?standalone=1`, creates two nodes, moves them to fixed canvas positions, connects them, saves, reloads, and verifies nodes, positions, visual link, and stored `next` relationship.
- Chrome 150.0.7871.115 result: Blocked. Chrome ignored/refused `--load-extension`; a minimal MV3 control extension was also not detected. Latest artifact paths printed under `%TEMP%\war-browser-mv3-artifacts\2026-07-14T08-20-07-466Z\`.
- Edge 150.0.4078.65 result: Pass via `npm run test:browser:edge`. Node/link persistence passed; latest artifact paths printed under `%TEMP%\war-browser-mv3-artifacts\2026-07-14T08-19-58-179Z\`.

Browser picker regression added on 2026-07-14:

- Test wiring corrected: browser acceptance scripts are `test/browser-mv3-persistence.js` and `test/browser-mv3-picker.js`, while dependency-free helper coverage is `test/browser-mv3-harness.test.js`.
- `npm test` now uses `node --test "test/**/*.test.js"` so future non-browser Node tests using the `.test.js` convention are included automatically without launching Chrome or Edge.
- `npm run test:browser:picker:edge` validates a local HTTP fixture with picker Accept, Cancel, Escape, scroll/resize target-box alignment, repeated cleanup, and selector persistence.
- Focused production defect found and fixed in `src/content-script.js`: during picker scroll/resize, body/html hover events could replace the last meaningful target and leave the target box following the page body. The fix keeps the previous meaningful hover target and updates on mousemove as well as mouseover.
- Edge 150.0.4078.65 picker result: Pass. Latest artifact paths printed under `%TEMP%\war-browser-mv3-artifacts\2026-07-14T08-42-35-625Z-picker\`.
- Chrome 150.0.7871.115 default browser result remains Blocked, not Fail. Latest blocked artifact paths printed under `%TEMP%\war-browser-mv3-artifacts\2026-07-14T08-42-50-730Z-persistence\`.

Browser root-node regression added on 2026-07-14:

- Root semantics: roots are nodes with no incoming link from `next`, `ifSteps`, `elseSteps`, or `conditions[].next`. Root state is derived from `findRootStepIds()` and no `isRoot` field is persisted.
- New commands `npm run test:browser:roots` and `npm run test:browser:roots:edge` use the existing dependency-free CDP harness and are not included in `test:all`.
- Edge 150.0.4078.65 result: Pass via `npm run test:browser:roots:edge`. The regression creates A, B, C, D log nodes, verifies A/C roots, verifies only A after B→C, verifies A/C after removing B→C and after save/reload, runs the profile, and observes log order A, B, C, D with each node executed once.
- Focused production defect found and fixed in `ui/canvas-editor.js`: root highlights were recalculated for graph edits but not after `loadData()`, so save/reload could display no roots until recalculated manually.

Browser switch-tab regression added on 2026-07-14:

- Switch Tab keeps the existing `tabName` schema field, trims it, rejects empty values, treats `*` as a case-insensitive wildcard over the complete URL/title, preserves substring matching when no `*` is present, and excludes restricted browser/extension URLs as run targets.
- The content script now awaits `WAR_SWITCH_TAB`; the service worker selects the most recently accessed matching supported web tab, focuses it, retries content-script delivery once via `chrome.scripting.executeScript` on HTTP/HTTPS pages only, sends only continuation `startIds`, and records `runtime.running` against the new tab.
- Initial profile start now rejects unsupported active pages and falls back to the most recently accessed supported web tab instead of blindly sending to the editor/extension page.
- New commands `npm run test:browser:switch-tab` and `npm run test:browser:switch-tab:edge` use the existing dependency-free CDP harness and are not included in `test:all`.
- Edge 150.0.4078.65 result: Pass via `npm run test:browser:switch-tab:edge`. The regression observes `before-switch` in the source tab, wildcard URL matching to the target tab, `after-switch` in the target tab, no receiver-connection error, and a controlled no-match failure that does not execute the destination node.

## Important Files Changed

## Chromium Control Platform Phase 2

Updated: 2026-07-16

Status: Complete. Phase 2 Native X11 Gate passed three consecutive Linux container performance runs.

Phase 2 adds typed Chromium control without WebRTC, VNC/noVNC, Native Messaging, arbitrary JavaScript, generic CDP passthrough, remote shell, file transfer, scheduler expansion, or Phase 3 work.

Implemented:

- Semantic page commands: `page.click`, `page.doubleClick`, `page.hover`, `page.focus`, `page.fill`, `page.type`, `page.press`, `page.selectOption`, `page.check`, `page.uncheck`, `page.scroll`, `page.waitFor`, `page.getElementState`, `page.listInteractiveElements`, `page.uploadFile`, `page.handleDialog`, `page.screenshot`.
- Raw input commands: `input.mouseMove`, `input.mouseDown`, `input.mouseUp`, `input.click`, `input.wheel`, `input.keyDown`, `input.keyUp`, `input.insertText`, `input.shortcut`, `browser.focusWindow`, `browser.openInternalPage`, `input.stopAll`, `input.getState`.
- Module split under `platform/browser-agent/src/`: semantic controller, raw input controller, target validator, coordinate mapper, input safety, emergency stop, screenshot controller, artifact registry.
- Upload allowlist maps `artifactId` to real files under `/data/uploads` only; absolute client paths and `../` are rejected.
- Browser-space raw input now defaults to a persistent native Xlib/XTest helper over `/run/war/x11-input.sock`; `xdotool` is retained only behind `WAR_X11_BACKEND=xdotool` as an explicit diagnostic fallback.
- Internal page allowlist covers `chrome://settings/`, `chrome://extensions/`, `chrome://downloads/`, `chrome://version/`, `chrome://flags/`, and the Web Action Recorder extension side panel/page.
- StopAll releases tracked held keys/buttons, clears queued input, and returns input state to idle.

Latest verification:

- Windows baseline before Phase 2: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 85 tests.
- Linux baseline before Phase 2: `npm run check` Pass; `npm run test:all` Pass, 85 tests; `npm run container:browser-agent:smoke` Pass.
- Baseline commit: `e83ef8764fa26981ca1b8f3fe36d86c50a769f41` on `main`.
- Final Windows: `npm.cmd run check` Pass; `npm.cmd run test:all` Pass, 123 tests verified.
- Final Linux: `npm run check` Pass; `npm run test:all` Pass, 123 tests verified.
- Container build: `npm run container:browser-agent:build` Pass.
- Container Phase 1 regression: `npm run container:browser-agent:smoke` Pass.
- Container Phase 2 smoke: `npm run container:browser-agent:phase2-smoke` Pass.
- Phase 2 performance measure: `npm run test:browser-agent:phase2-performance:measure` Pass.
- Phase 2 performance gate: `npm run test:browser-agent:phase2-performance:gate` Pass, three consecutive runs.
- Artifact location: `/opt/war/phase2-gate-e83ef8764fa2-20260716001243/artifacts/browser-agent/`.

Evidence:

- Chromium: `150.0.7871.114`.
- Extension ID/version: `edoicfpldmlabgdalemfgflpldiijdmm` / `0.1.0`.
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

Known deployment risk remains:

- The Docker host rejects Chromium namespace sandboxing with `Operation not permitted`; the container gate uses explicit `WAR_BROWSER_NO_SANDBOX=1` and the Agent logs a warning. No `--no-sandbox` is silently added by default config.

Next milestone:

- Outbound Agent Session and Controller Core.

- `src/graph.js`
- `src/template.js`
- `src/shared.js`
- `src/service-worker.js`
- `src/content-script.js`
- `ui/canvas-editor.js`
- `ui/sidepanel.html`
- `ui/sidepanel.js`
- `ui/options.html`
- `ui/options.js`
- `ui/style.css`
- `companion/server.js`
- `companion/auth.js`
- `companion/store.js`
- `companion/scheduler.js`
- `test/graph-template.test.js`
- `test/scheduler.test.js`
- `test/companion.integration.test.js`
- `test/browser-mv3-harness.js`
- `test/browser-mv3-harness.test.js`
- `test/browser-mv3-picker.js`
- `test/browser-mv3-roots.js`
- `test/browser-mv3-switch-tab.js`
- `package.json`
- `README.md`
- `test/browser-mv3-persistence.js`
- `docs/ADR-0001-chromium-control-platform-planes.md`
- `platform/PLATFORM_STATE.md`
- `platform/input-parser/src/inputParser.js`
- `platform/input-parser/test/inputParser.test.js`
- `platform/protocol/schemas/command-status.v1.schema.json`
- `platform/protocol/schemas/war-control-envelope.v1.schema.json`
- `platform/protocol/schemas/workflow-revision-metadata.v1.schema.json`
- `platform/protocol/src/schemaValidator.js`
- `platform/protocol/test/protocolSchemas.test.js`
- `platform/workflow-core/src/workflowMetadata.js`
- `platform/workflow-core/test/workflowMetadata.test.js`

## Remaining Risk

Automated browser coverage now includes the first MV3 persistence harness, but broader UI/E2E is still not present. Before using this as a production workflow runner, manually validate in a controllable Chrome/Edge session where unpacked extension loading is available:

- Load unpacked in Chrome and Edge.
- Drag link source to target and reload profile.
- Picker candidate list/preview/accept/cancel on real pages.
- Stop while waiting for a missing selector.
- Companion dashboard with at least two real endpoints on LAN/VPN.
- Phase 0 platform schemas are covered by a lightweight local validator in tests, not by a production JSON Schema validator dependency.
- The external plan document `CHROMIUM_CONTROL_PLATFORM_CODEX_PLAN.md` was unavailable in the source tree during Phase 0.

## Next Best Step

Bắt đầu Giai đoạn 1 — Browser Agent tối thiểu sau khi người dùng phê duyệt.
## Chromium Control Platform Phase 1

Updated: 2026-07-14

Status: Implemented but Gate Blocked.

Baseline before Phase 1 changes:

- Node: `v24.14.1`.
- Docker: unavailable; `docker` was not recognized.
- Docker Compose: unavailable because `docker` was not recognized.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass; extension tests 25/25 and Phase 0 platform tests 22/22.
- `docs/CHROMIUM_CONTROL_PLATFORM_CODEX_PLAN.md` was still missing, so Phase 1 followed the user-provided checklist.

Phase 1 adds:

- Browser Agent Node.js modules under `platform/browser-agent/src/`.
- Persistent `/data/device/identity.json`.
- Headed Chromium launch support through `playwright-core` and system Chromium.
- Persistent Chromium profile at `/data/chromium-profile`.
- Read-only extension loaded detection via `chrome-extension://` service worker target.
- Browser supervisor states and bounded restart policy.
- Localhost-first HTTP API: `/health`, `/v1/state`, `/v1/control`.
- `war-control.v1` command support for `browser.getState`, `browser.start`, `browser.stop`, `browser.restart`, `tab.list`, `tab.open`, `tab.activate`, `tab.navigate`, and `tab.close`.
- Dockerfile, Xvfb entrypoint, and Phase 1 compose file with localhost port binding, `shm_size: 1gb`, no privileged mode, no host networking, and no Docker socket.
- Browser Agent unit tests: 30/30 pass.
- `playwright-core` dependency pinned by `package-lock.json`; Playwright browser downloads are disabled.

Post-change verification:

- `npm.cmd run test:browser-agent:unit`: Pass, 30/30.
- `npm.cmd run check:browser-agent`: Pass.
- `npm.cmd run test:platform`: Pass; Phase 0 platform tests 22/22 and Browser Agent tests 30/30.
- `npm.cmd run check`: Pass.
- `npm.cmd run test:all`: Pass; extension tests 25/25, Phase 0 platform tests 22/22, Browser Agent tests 30/30.
- `npm.cmd run container:browser-agent:build`: Blocked; `docker` is not recognized.
- `npm.cmd run container:browser-agent:smoke`: Blocked; `docker` is not recognized.

Phase 1 intentionally does not add streaming, VNC, Windows/Tauri app code, Native Messaging, file transfer, clipboard, extension install/update/uninstall APIs, raw X11 input, arbitrary JavaScript, CDP passthrough, remote shell, or public listener defaults.

Container verification remains blocked until Docker is available. Required commands:

- `npm.cmd run container:browser-agent:build`
- `npm.cmd run container:browser-agent:smoke`

## Next Best Step After Phase 1

Bắt đầu Giai đoạn 2 — Điều khiển Chromium toàn phần sau khi người dùng phê duyệt.

## Chromium Control Platform Phase 1 Gate Closure

Updated: 2026-07-15

Status: Complete.

The Phase 1 real-container Gate was closed on Linux host `root@192.168.1.201`.

Environment:

- Ubuntu 24.04.4 LTS, kernel `6.8.0-124-generic`, x86_64.
- Docker Engine 29.4.2.
- Docker Compose v5.1.3.
- Host Node.js v24.14.1 and npm 11.11.0.

Source sync:

- Windows remains source of truth: `C:\Users\huynh cong thanh\Downloads\assistant-media\web-action-recorder-extension-v4`.
- Linux deployment path: `/opt/war/web-action-recorder-extension-v4`.
- SHA-256 matched for package files, manifest, Dockerfile, compose file, and Browser Agent controller/supervisor.

Gate results:

- `npm run test:browser-agent:unit`: Pass, 38/38.
- `npm run check:browser-agent`: Pass.
- `npm run test:platform`: Pass, Phase 0 platform 22/22 and Browser Agent 38/38.
- `npm run check`: Pass.
- `npm run test:all`: Pass, extension 25/25, Phase 0 platform 22/22, Browser Agent 38/38.
- `npm run container:browser-agent:build`: Pass.
- `npm run container:browser-agent:smoke`: Pass.
- `npm run test:browser-agent:integration`: Pass, 1/1 real Chromium container smoke.
- `npm run test:browser-agent:soak`: Pass, 100 iterations.

Container evidence:

- Image: `war-browser-agent:phase1`.
- Image ID: `sha256:35518cfa30b89ce208407345f0917cb07897a63131d07f8c054b61fe8a064659`.
- Image size: 1.35 GB disk usage, 359 MB content size.
- Container user: `war` (`uid=1001`), not root.
- Chromium: `150.0.7871.114`.
- Container Node.js: `v22.23.1`.
- `playwright-core`: `1.61.1`.
- Browser-ready time: 2317 ms.
- Extension loaded: `edoicfpldmlabgdalemfgflpldiijdmm`, version `0.1.0`.
- Device ID persisted through container restart.
- Fixture marker persisted through Chromium restart and container restart.
- 100-tab soak: average 124 ms, p95 132 ms, 0 errors, 0 timeouts, tab count 1 -> 1, process count 12 -> 11, memory 274.2 MiB -> 300.6 MiB.

Patches added during Gate closure:

- Real Docker smoke/integration runner and 100-tab soak runner.
- Xvfb readiness check with finite timeout.
- `chromium-sandbox` and `x11-utils` in the image.
- Stable tab ID registry and active tab tracking.
- Extension detection that can confirm the extension page even when the MV3 service worker is asleep.
- Container remote bind guarded by token and allowlist while host publish remains `127.0.0.1`.

Known deployment risk:

- The Docker host rejects Chromium namespace sandboxing with `Operation not permitted`; Phase 1 gate uses explicit `WAR_BROWSER_NO_SANDBOX=1` and logs a warning. No `--no-sandbox` is silently added by default config.

Next step remains:

Bắt đầu Giai đoạn 2 — Điều khiển Chromium toàn phần sau khi người dùng phê duyệt.
