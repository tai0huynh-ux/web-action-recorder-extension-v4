# Electron Controller

## Development Startup

```powershell
npm.cmd run controller:electron
```

The app opens the secure Controller shell at `war-controller://app/`.

## Runtime Configuration

Optional environment variables:

- `WAR_CONTROLLER_ELECTRON_DATA_PATH`: local controller data directory.
- `WAR_CONTROLLER_WSS_ENABLED=1`: request WSS listener startup.
- `WAR_CONTROLLER_WSS_HOST`: bind host, default `127.0.0.1`.
- `WAR_CONTROLLER_WSS_PORT`: bind port, default `0`.
- `WAR_CONTROLLER_TLS_CERT_PATH`: TLS certificate path for WSS.
- `WAR_CONTROLLER_TLS_KEY_PATH`: TLS private key path for WSS.
- `WAR_CONTROLLER_ALLOW_LAN=1`: required before binding non-loopback hosts.
- `WAR_CONTAINER_RUNTIME`: `local-docker`, `ssh-docker`, or `disabled`.
- `WAR_CONTAINER_HOST_LABEL`: safe display name for the configured Docker host.
- `WAR_CONTAINER_SSH_TARGET` and `WAR_CONTAINER_SSH_IDENTITY_FILE`: backend-only SSH Docker connection settings.

The WSS environment is a first-launch bootstrap or an explicit rotation override. After a successful WSS bind, the main process writes a validated `controller-runtime.json` under the Electron user-data directory with only the enabled flag, safe bind host, actual bound port, LAN approval, and TLS certificate/key paths. A later direct launch restores that profile when the WSS environment is absent. The profile never stores PEM contents, Agent credentials, tokens, or SSH connection settings, and it is never exposed to the renderer. An invalid explicit override fails closed and does not replace the last-good profile.

An approved SSH Docker host remains in the backend settings store and is probed again on startup. Reopening the app therefore restores the saved Linux host and managed-container records, starts the persisted WSS endpoint, and reconciles live Docker and Agent state without requiring the original bootstrap shell to remain open.

The renderer only receives safe metadata such as WSS status, safe bind host, port, store loaded/degraded state, and the configured Docker host ID/display label. It never receives the SSH target, identity path, private key, or credentials. Managed Agent credentials are generated with cryptographically secure random bytes only when missing; repair and repeated provisioning preserve an existing credential hash and never rotate it implicitly. TLS certificate and key files are preserved and are not silently regenerated.

## Managed Containers

Open **Thêm container** in Workspace to probe the configured Docker host. The machine selector lists only a host whose Docker server probe succeeds. The Controller re-probes the selected allowlisted host when **Tạo** is pressed and rejects renderer-supplied host IDs that are not configured.

The user chooses the display-name prefix, sequence number, and IPv4/IPv6 settings. The main process owns the approved image, unique Docker name, managed Agent identity and credential, isolated data volume, WSS settings, resource limits, and AppArmor/seccomp/browser-sandbox policy. After provisioning succeeds, the new container is refreshed into the managed application list where Start, Stop, Restart, Refresh, network settings, Duplicate, and Delete remain available.

New provisioning always requires the current versioned managed-network labels. Repair and startup may preserve an older network only when it is already attached to the immutable, ownership-verified canonical container and its exact legacy identity and topology pass the compatibility policy. Repair never performs an implicit topology migration and never removes or reuses a shared or foreign network.

Linux host repair installs the reviewed AppArmor profile at `/etc/apparmor.d/war-browser-agent`, verifies its pinned hash and root-only ownership, and loads it in enforce mode. The top-level path is intentional: Ubuntu's AppArmor boot loader reloads it after a host restart. The Controller fails the host readiness probe instead of starting a managed container when that profile, the reviewed seccomp policy, or the Controller CA is unavailable.

## Pairing Workflow

Use Pairing to paste or import a `DeviceDescriptor` JSON file, request pairing, enter the one-time pairing code, and confirm or reject the pending pairing. The one-time credential is displayed only from confirm response and can be cleared manually. It is cleared when leaving Pairing.

Paired agents can be reconnected from the Pairing view. **Delete** revokes the pairing credential, closes the active session, and removes the agent from the active pairing list while retaining a redacted revocation history for audit.

## Workflows

Use Workflows to import a `WorkflowRevision` JSON payload. Metadata is listed separately from profile payload details. Payloads are rendered as text, never as HTML. Required inputs are shown, and sensitive inputs are marked unsupported.

## Dispatch And Cancel

Use Jobs to dispatch one workflow revision to one paired, online device. The renderer supplies only device, workflow, revision, deadline seconds, and workflow input values. Controller Core owns generation, session, lease, content hash, deadline, and idempotency.

The Jobs view separates job persistence, transport delivered/warning, acknowledgement, execution status, and cancel state. Cancel is controller-side and reports transport delivery separately.

Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS. When WSS execution updates arrive from a paired Browser Agent, the Electron runtime invalidates the Jobs view so persisted acknowledgement, progress, result, and cancel state can be refreshed from Controller Core.

## Lightweight Live Control

Open **Điều khiển trực tiếp** to view and control managed CloakBrowser containers whose Agent session is online. The Controller requests bounded JPEG viewport frames over the existing authenticated WSS session; it does not expose VNC, noVNC, WebRTC, arbitrary CDP, remote shell, or a new public Agent listener.

Up to eight containers can be selected. With synchronization disabled, mouse and keyboard input is sent only to the active screen. With synchronization enabled, the same bounded command is fanned out concurrently and carries a shared execution timestamp. The view supports pointer movement, click/drag, wheel input, normal text entry, and the allowlisted shortcuts `Ctrl+T`, `Ctrl+C`, `Ctrl+V`, `Ctrl+L`, `Ctrl+W`, `Ctrl+R`, `Ctrl+Shift+T`, `Alt+Left/Right`, `F5`, and `Escape`.

Frame rate is user-selectable from 1, 3, or 6 FPS. Higher rates reduce JPEG quality to limit LAN bandwidth. **Copy from browser** requests the current selection from exactly one active device and writes it in the Electron main process to the Controller OS clipboard. **Paste to browser** reads that OS clipboard only in the main process and sends bounded text to the explicitly selected devices. The renderer receives only byte-count metadata; clipboard text is not persisted, logged, cached, or continuously synchronized.

## Diagnostics

Diagnostics can run a bounded connectivity/security check across Controller WSS, configured Linux hosts, managed containers, paired Agents, and active sessions. Each result has a stable code, severity, target, and safe repair action. **Fix detected issues** repairs failed Linux hosts, requests Agent reconnect, retries failed containers, and reloads the existing WSS TLS certificate/key into the running HTTPS server when supported. It never prints or regenerates private keys, credentials, certificate contents, or raw remote output; if a certificate must be renewed, replace it through the reviewed TLS process first, then use **Reload WSS/TLS**.

## Tests

```powershell
npm.cmd run check:controller-electron
npm.cmd run test:controller-electron:unit
npm.cmd run test:controller-electron:smoke
npm.cmd run package:controller-electron
npm.cmd run dist:controller-electron
npm.cmd run test:controller-electron:packaged
npm.cmd run test:controller-electron
```

`test:controller-electron:smoke` runs real Electron `43.1.1`, uses temporary userData and controller state, writes a sanitized local artifact under `artifacts/controller-electron/`, and cleans up the runtime.

`test:controller-extension:e2e` runs the local Edge MV3 Controller-to-Extension gate through Browser Agent, Native Messaging, and the generated temporary Windows native host executable shim.

## Packaging

`package:controller-electron` builds the unpacked Windows package under `dist/release/controller-electron/win-unpacked/`.

`dist:controller-electron` builds the Windows NSIS installer and portable executable. The packaged gate launches the unpacked executable and a temp-installed NSIS copy with temporary state and TLS/WSS configuration, then uninstalls the temp copy.

Development artifacts are unsigned unless a real signing certificate is supplied through the release signing environment. See `docs/RELEASE_PACKAGING.md`.

## Known Limitations

- Sensitive workflow inputs are unsupported.
- Production Authenticode signing was not executed without external certificate material.
- Production LAN/TLS deployment remains an explicit opt-in and is not covered by this local shell acceptance.
- Live control uses bounded JPEG snapshots at up to 6 FPS, not a 30/60 FPS video codec. Real LAN latency and multi-container bandwidth still require managed-container acceptance on the target Linux host.
