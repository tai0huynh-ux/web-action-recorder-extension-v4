# Web Action Recorder Runner MVP

Manifest V3 Chrome/Edge extension for recording, editing, and running browser workflows. The MVP includes a local drag-drop editor, target picker, graph runner, and a Node Companion Hub for secure LAN control of multiple extension endpoints.

## Secure Electron Controller

Run the local Controller shell:

```powershell
npm.cmd run controller:electron
```

Focused Electron gates:

```powershell
npm.cmd run check:controller-electron
npm.cmd run test:controller-electron:unit
npm.cmd run test:controller-electron:smoke
```

The Electron shell uses `war-controller://app/`, strict CSP, sandboxed/context-isolated renderer settings, a frozen preload API, sender-validated typed IPC, and plain HTML/CSS/ES modules. It supports pairing, managed containers, devices, groups, workflow import, origin synchronization, grouped input mapping/dispatch, action graph revision editing, job dispatch/cancel, diagnostics, and the Vietnamese-first Workspace route. Field picker backend work remains deferred.

Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS on the local Edge MV3 path. The active Chromium user-namespace sandbox and full container product path passed GitHub Actions run `29653528313` at SHA `995233b21f89a3376bf2631a5f69e91329cbdbd4`. Deterministic unsigned development packaging is available; production signing requires external certificate material.

## Container Real-World Gate

Latest accepted sandbox run: GitHub Actions `29653528313`.

The gate verifies a non-root, resource-bounded Browser Agent container; exact AppArmor and constrained seccomp policies; Chromium's authoritative `chrome://sandbox` status; MV3 Extension; Native Messaging; TLS WSS Controller dispatch; controlled search/copy execution; result uplink; terminal replay protection; cancel; and cleanup. Chromium reported SUID false with user, PID, network, seccomp-BPF, TSYNC, and overall sandbox status true.

Run the host probe with `npm.cmd run probe:chromium-sandbox-host` on a reviewed Linux Docker host. See `docs/PERSONAL_LAN_SETUP.md`, `docs/MVP_ACCEPTANCE.md`, and `docs/TROUBLESHOOTING.md`. Final personal-LAN readiness still requires Phase 10 acceptance and soak; the container gate alone is not that claim.

## Release Packaging

Build the release bundle explicitly:

```powershell
npm.cmd run release:bundle
npm.cmd run test:release:gate
```

The release bundle writes ignored artifacts under `dist/release/`: Windows NSIS installer, Windows portable Controller executable, `win-unpacked` packaged smoke target, Browser Agent ZIP, MV3 Extension ZIP, `release-manifest.json`, and `SHA256SUMS.txt`. See `docs/RELEASE_PACKAGING.md` for signing variables, integrity checks, installer/uninstall testing, and known limitations.

## Controller-to-Extension E2E

Run the local Controller-to-Extension gate:

```powershell
npm.cmd run test:controller-extension:e2e
```

The gate starts a real Controller WSS runtime, real Browser Agent, real Edge/Chromium MV3 extension, Native Messaging host, and the existing Extension graph runner. On Windows it compiles a temporary native host executable shim for the gate, registers the Edge Native Messaging manifest under HKCU, verifies the executable path, runs workflow dispatch/result/cancel/replay checks, then removes the registry key during cleanup. Generated executables, manifests, config files, logs, and artifacts are local-only and are not committed.

## MVP Features

- Side panel and standalone editor window.
- Drag-drop graph editor with click/keyboard ports, visible SVG links, zoom/pan, and resizable canvas.
- Root-node discovery with `🌱 Lấy nút gốc`, green root highlights, and `Gốc` badges. A root is any node with no incoming link from `next`, `ifSteps`, `elseSteps`, or `conditions[].next`; the root flag is derived and is not saved on steps.
- Step types: click, type, navigate, switchTab, log, condition, OR, AND, IFS.
- Target picker with candidate list, preview box, accept/cancel flow, and draggable chooser.
- Template inputs for type/navigation fields using `{{field}}`.
- Profile import/export, storage, logs, and enabled flag for remote runs.
- Companion Hub with admin token, enrollment token, per-device token, device heartbeat, per-device queue, lease/ack/result, batch creation, dataset assignment, and web dashboard.

## Install Extension

1. Open `chrome://extensions` or the Edge equivalent.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the repository root folder.
5. Open a normal web page and click the extension icon.

## Developer Checks

Run from this repository root:

```bash
npm run check
npm test
npm run test:all
```

`npm test` runs the dependency-light extension/Companion Node tests and does not launch Chrome or Edge. Use the explicit Edge and packaged/controller gates for browser and desktop acceptance.

## Browser MV3 Regression Harness

The browser harness is an explicit local acceptance command. It is not part of
`test:all` because installed Chrome/Edge policy and automation support vary by
machine.

On Windows, run:

```powershell
npm run test:browser
```

Optional browser selection:

```powershell
npm run test:browser:chrome
npm run test:browser:edge
npm run test:browser:picker
npm run test:browser:picker:edge
npm run test:browser:roots
npm run test:browser:roots:edge
npm run test:browser:switch-tab
npm run test:browser:switch-tab:edge
```

Override the browser executable path when needed:

```powershell
$env:WAR_BROWSER_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:browser
```

The harness uses the installed browser directly through the Chrome DevTools
Protocol. It does not automate the native "Load unpacked" file picker and does
not access external websites. It launches a temporary browser profile outside
the source tree, attempts to load this folder with `--load-extension`, verifies
the MV3 extension target/service worker, opens the extension editor URL, creates
two nodes, moves them, links them, saves, reloads, and verifies node/link
persistence in extension storage.

`npm run test:browser:picker:edge` launches Edge with the extension, serves a
local HTTP picker fixture, and validates picker Accept, Cancel, Escape,
scroll/resize target-box alignment, repeated cleanup, and selector persistence.
It uses CDP mouse, keyboard, wheel, and viewport events for browser-sensitive
interactions.

`npm run test:browser:roots:edge` launches Edge with the extension, creates
four log nodes A/B/C/D, verifies root highlighting for A/C, verifies A alone
after adding B→C, verifies A/C after removing B→C and after save/reload, then
runs the profile and verifies log execution order A, B, C, D with every node
executing once.

`npm run test:browser:switch-tab:edge` launches Edge with the extension and a
local HTTP fixture, starts a profile in a source tab, matches a target tab by a
case-insensitive wildcard URL pattern, transfers continuation execution to the
target tab, and verifies a nonmatching pattern fails without running the
destination node.

If the installed browser refuses `--load-extension`, the command exits as
Blocked and prints actionable diagnostics plus artifact paths under:

```text
%TEMP%\war-browser-mv3-artifacts\
```

Blocked status is expected on machines where Chrome/Edge policy or automation
mode prevents unpacked extension loading.

## Companion Hub

Create two random tokens with at least 24 characters. Keep localhost as the default unless you are on a trusted LAN/VPN.

```powershell
$env:WAR_ADMIN_TOKEN='replace-with-random-admin-token-32-chars'
$env:WAR_ENROLLMENT_TOKEN='replace-with-random-enroll-token-32-chars'
npm run companion
```

Open the dashboard:

```text
http://127.0.0.1:17373/dashboard
```

In the extension Options page, enter:

- Companion URL: `http://127.0.0.1:17373`
- Endpoint name: a readable machine/browser name
- Enrollment token: the same value as `WAR_ENROLLMENT_TOKEN`
- Enable Companion

The extension enrolls itself, stores its device token, sends heartbeat/profile metadata, and receives only commands assigned to that endpoint.

For LAN opt-in:

```powershell
$env:WAR_HOST='0.0.0.0'
$env:WAR_ALLOW='127.0.0.1,192.0.2.10,192.0.2.11'
npm run companion
```

Each remotely controlled profile must be enabled in the extension before it can run from the Hub. The dashboard can run one profile on multiple endpoints with shared, per-device, random-pool, or mapping inputs.

## Known MVP Limits

- Public Internet control is out of scope; use trusted LAN or VPN/Tailscale.
- Production Authenticode signing requires external certificate material.
- The extension still uses broad host access for its recorder/runner; review profiles and granted sites before personal use.
- Generic high-risk action classification is not implemented; use controlled workflows and explicit operator review.
- Navigation continuation targets the same tab; very complex tab chains need more hardening.
- Controller-dispatched sensitive inputs are unsupported; extension-side secret typing remains blocked unless a step explicitly opts in with `recordSecret`.
