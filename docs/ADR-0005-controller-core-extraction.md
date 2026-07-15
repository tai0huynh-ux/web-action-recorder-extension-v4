# ADR-0005: Controller Core Extraction

Status: Accepted

Date: 2026-07-16

## Context

Companion Hub HTTP routes contained device mutation, command scheduling, dataset assignment, and job state transition logic. The next architecture step needs the same controller behavior to be reusable by Companion HTTP compatibility, future outbound Agent sessions, Electron Controller, and test harnesses without copying business rules.

## Decision

Controller Core is extracted under `platform/controller-core/`. It is an internal domain layer with no HTTP server, WebSocket, Electron, Chrome API, or fixed filesystem path dependency.

The Companion HTTP server is now a compatibility adapter. It parses requests, performs boundary authentication, calls Controller Core, and maps domain results back to the existing response shapes and status codes.

Browser Agent remains the authoritative device identity in the final architecture. Legacy Extension enrollment remains a compatibility model for Companion HTTP and is not the final endpoint authority model.

The existing JSON store is retained temporarily through a persistence adapter. The store now carries controller migration metadata, backs up before migration, and copies corrupt files aside instead of silently resetting data.

## Module Boundaries

Controller Core contains:

- DeviceRegistry
- WorkflowRegistry
- GroupRegistry
- JobService
- Scheduler compatibility helpers
- ExecutionEventStore
- AuthPolicy
- AuditService
- PersistenceAdapter

`companion/server.js` must not own scheduler, device mutation, workflow revision, dataset assignment, or state transition rules.

## Rejected Alternatives

- Writing a second controller beside Companion: rejected because it would duplicate scheduling and state transitions.
- Moving directly to SQLite: rejected because this task only needs a JSON persistence adapter and migration metadata.
- Implementing WSS, Electron, pairing runtime, or WebRTC now: rejected as out of scope.
- Changing Companion public API shapes: rejected to preserve compatibility.
