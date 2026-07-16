# ADR-0007: Secure Electron Controller Shell

Date: 2026-07-16
Status: Accepted

## Context

The Controller needs a local desktop shell for pairing agents, viewing safe runtime state, managing groups and WorkflowRevision metadata, dispatching single-device jobs, and cancelling jobs. The shell must not weaken Controller Core authority or expose Node, Electron, filesystem, socket, store, credential, or TLS material to renderer code.

## Decision

The Electron Controller uses a strict main/preload/renderer trust boundary:

- Main owns Controller Core, JSON persistence, runtime configuration, WSS listener ownership, active authenticated WSS sessions, IPC handlers, import dialogs, and the custom `war-controller://app/` protocol.
- Preload exposes a frozen, typed `window.warController` API. It has fixed channel bindings only and no generic RPC.
- Renderer is plain HTML/CSS/ES modules. It can only call `window.warController`, build DOM with safe node APIs, and render JSON through `textContent` in `pre` nodes.

Renderer assets are served through the custom `war-controller://app/` protocol. The protocol rejects unknown hosts, unknown asset types, traversal, encoded traversal, backslash traversal, null bytes, absolute path attempts, and access to source, preload, state, or TLS files. Responses use the strict CSP from `appProtocol.js`.

BrowserWindow is created with sandbox enabled, context isolation enabled, Node integration disabled, worker/subframe Node integration disabled, web security enabled, insecure content disabled, and webview disabled. Navigation, window creation, and permission requests are denied unless they stay inside the controller origin.

IPC sender validation requires the trusted main frame at `war-controller://app/`. Invalid senders receive `AUTH_DENIED` before application methods run, so they cannot create groups, jobs, or other state mutations.

Controller Core remains the authority for pairing, devices, groups, workflows, jobs, sessions, persistence, dispatch idempotency, cancel semantics, and sanitization. Electron maps renderer requests into typed application methods only.

## One-Time Pairing Credentials

Pairing credentials are returned only by confirm response. They are not placed in global renderer application state, storage APIs, logs, artifacts, hashes, or automatic clipboard writes. The Pairing view keeps the value in a local module reference, provides a clear action, and clears the reference when leaving the view.

## Dispatch Semantics

The renderer can dispatch a single device by choosing device, workflow, revision, deadline seconds, and workflow input values. It cannot provide generation, session ID, job ID, lease ID, workflow content hash, idempotency key, or an absolute deadline. The application persists the job before transport delivery and reports transport delivery/warning separately from execution status. A successful socket send is not treated as `running`.

Sensitive workflow inputs are currently unsupported and rejected by the Controller application service.

## Persistence And WSS Ownership

Electron resolves a local state directory from runtime configuration and passes a JSON store to Controller Core. WSS, when enabled, is owned by the main process over TLS/WSS only. Active authenticated connections are tracked by the Controller WSS runtime and Controller Core session registry.

## Rejected Alternatives

- `file://` renderer.
- `nodeIntegration`.
- Generic IPC RPC.
- Renderer filesystem access.
- Renderer direct store access.
- Renderer-owned sockets.
- Public pairing HTTP endpoint.
- `ws://` fallback.
- TLS bypass.
- Credential persistence.
