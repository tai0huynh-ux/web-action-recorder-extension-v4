# ADR-0003: Endpoint Authority and Extension Bridge

Status: Accepted

Date: 2026-07-16

## Context

The project now has an Extension recorder/runner, Companion scheduling path, and Browser Agent control plane. The next architecture step needs stable contracts before adding persistent controller sessions or Native Messaging runtime.

## Decision

Browser Agent is the authoritative device identity. It owns the endpoint descriptor, presence status, protocol version, and device capability report.

The Extension is not modeled as an independent device in the final architecture. It is a local execution component running inside a Browser Agent endpoint.

The existing Extension graph runner remains the primary workflow execution engine for workflows created by the recorder. Browser Agent semantic and raw controllers support live control, diagnostics, fallback, and operations outside workflow execution; they do not replace the graph runner.

Native Messaging is reserved for a later milestone. This milestone only defines NativeBridgeEnvelope and pairing contracts.

The current Extension-to-Companion polling path remains as a compatibility path until the Controller session architecture replaces it.

## Rationale

This keeps the current recorder/replayer behavior stable while allowing the platform to converge on one endpoint/device authority. It also avoids rewriting the whole system before contracts, validation, and adapter boundaries are locked.

## Consequences

- Protocol v2 uses Browser Agent device descriptors and capabilities.
- WorkflowRevision stores deterministic workflow content and sanitized Extension profile payloads.
- Dispatch and execution contracts are transport-agnostic.
- Pairing and Native Messaging are contract-only in this milestone.
- Companion status mapping is handled by a compatibility adapter without changing Companion scheduler runtime.
