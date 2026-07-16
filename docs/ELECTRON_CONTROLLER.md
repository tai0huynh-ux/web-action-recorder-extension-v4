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

The renderer only receives safe metadata such as WSS status, safe bind host, port, and store loaded/degraded state.

## Pairing Workflow

Use Pairing to paste or import a `DeviceDescriptor` JSON file, request pairing, enter the one-time pairing code, and confirm or reject the pending pairing. The one-time credential is displayed only from confirm response and can be cleared manually. It is cleared when leaving Pairing.

Paired agents can be listed and revoked from the Pairing view.

## Workflows

Use Workflows to import a `WorkflowRevision` JSON payload. Metadata is listed separately from profile payload details. Payloads are rendered as text, never as HTML. Required inputs are shown, and sensitive inputs are marked unsupported.

## Dispatch And Cancel

Use Jobs to dispatch one workflow revision to one paired, online device. The renderer supplies only device, workflow, revision, deadline seconds, and workflow input values. Controller Core owns generation, session, lease, content hash, deadline, and idempotency.

The Jobs view separates job persistence, transport delivered/warning, acknowledgement, execution status, and cancel state. Cancel is controller-side and reports transport delivery separately.

Controller-to-Extension Workflow Execution Downlink and E2E Gate: PASS. When WSS execution updates arrive from a paired Browser Agent, the Electron runtime invalidates the Jobs view so persisted acknowledgement, progress, result, and cancel state can be refreshed from Controller Core.

## Diagnostics

Diagnostics shows application version, protocol version, WSS status, safe bind host, port, store loaded/degraded indicator, and last refresh time. It does not show environment, full state path, certificate path, private key path, credentials, tokens, hashes, raw store, raw errors, or stacks.

## Tests

```powershell
npm.cmd run check:controller-electron
npm.cmd run test:controller-electron:unit
npm.cmd run test:controller-electron:smoke
npm.cmd run test:controller-electron
```

`test:controller-electron:smoke` runs real Electron `43.1.1`, uses temporary userData and controller state, writes a sanitized local artifact under `artifacts/controller-electron/`, and cleans up the runtime.

`test:controller-extension:e2e` runs the local Edge MV3 Controller-to-Extension gate through Browser Agent, Native Messaging, and the generated temporary Windows native host executable shim.

## Known Limitations

- Sensitive workflow inputs are unsupported.
- Packaging and code signing are not included.
- Production LAN/TLS deployment remains an explicit opt-in and is not covered by this local shell acceptance.
