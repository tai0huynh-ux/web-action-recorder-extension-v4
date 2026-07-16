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

The Electron shell uses `war-controller://app/`, strict CSP, sandboxed/context-isolated renderer settings, a frozen preload API, sender-validated typed IPC, and plain HTML/CSS/ES modules. It supports pairing, devices, groups, workflow import, job dispatch/cancel, and diagnostics. Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS on the local Edge MV3 path. Sensitive workflow inputs, packaging, and signing are later milestones.

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
4. Select this folder: `C:\Users\a\Documents\web-action-recorder-extension-v4`.
5. Open a normal web page and click the extension icon.

## Developer Checks

Run from this repository root:

```bash
npm run check
npm test
npm run test:all
```

`npm test` runs dependency-free Node tests only. As of the current harness
work, it reports 25 tests and does not launch Chrome or Edge.

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
$env:WAR_ALLOW='127.0.0.1,192.168.1.10,192.168.1.11'
npm run companion
```

Each remotely controlled profile must be enabled in the extension before it can run from the Hub. The dashboard can run one profile on multiple endpoints with shared, per-device, random-pool, or mapping inputs.

## Known MVP Limits

- Public Internet control is out of scope; use trusted LAN or VPN/Tailscale.
- Browser E2E/manual Chrome and Edge validation is still required before relying on this in production.
- Navigation continuation targets the same tab; very complex tab chains need more hardening.
- Secret typing is blocked unless a step explicitly opts in with `recordSecret`.
