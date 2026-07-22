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

The renderer only receives safe metadata such as WSS status, safe bind host, port, store loaded/degraded state, and the configured Docker host ID/display label. It never receives the SSH target, identity path, private key, or credentials. Managed Agent credentials are generated with cryptographically secure random bytes only when missing; repair and repeated provisioning preserve an existing credential hash and never rotate it implicitly. TLS certificate and key files are preserved and are not silently regenerated.

## Managed Containers

Open **Thêm container** in Workspace to probe the configured Docker host. The machine selector lists only a host whose Docker server probe succeeds. The Controller re-probes the selected allowlisted host when **Tạo** is pressed and rejects renderer-supplied host IDs that are not configured.

The user chooses the display-name prefix, sequence number, and IPv4/IPv6 settings. The main process owns the approved image, unique Docker name, managed Agent identity and credential, isolated data volume, WSS settings, resource limits, and AppArmor/seccomp/browser-sandbox policy. After provisioning succeeds, the new container is refreshed into the managed application list where Start, Stop, Restart, Refresh, network settings, Duplicate, and Delete remain available.

## Pairing Workflow

Use Pairing to paste or import a `DeviceDescriptor` JSON file, request pairing, enter the one-time pairing code, and confirm or reject the pending pairing. The one-time credential is displayed only from confirm response and can be cleared manually. It is cleared when leaving Pairing.

Paired agents can be reconnected from the Pairing view. **Delete** revokes the pairing credential, closes the active session, and removes the agent from the active pairing list while retaining a redacted revocation history for audit.

## Workflows

Use Workflows to import a `WorkflowRevision` JSON payload. Metadata is listed separately from profile payload details. Payloads are rendered as text, never as HTML. Required inputs are shown, and sensitive inputs are marked unsupported.

## Dispatch And Cancel

Use Jobs to dispatch one workflow revision to one paired, online device. The renderer supplies only device, workflow, revision, deadline seconds, and workflow input values. Controller Core owns generation, session, lease, content hash, deadline, and idempotency.

The Jobs view separates job persistence, transport delivered/warning, acknowledgement, execution status, and cancel state. Cancel is controller-side and reports transport delivery separately.

Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS. When WSS execution updates arrive from a paired Browser Agent, the Electron runtime invalidates the Jobs view so persisted acknowledgement, progress, result, and cancel state can be refreshed from Controller Core.

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
