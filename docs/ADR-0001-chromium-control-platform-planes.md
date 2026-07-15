# ADR 0001: Chromium Control Platform Planes

Status: Accepted for Phase 0 baseline.

## Context

The Chromium Control Platform extends Web Action Recorder v4 without changing the current extension runtime behavior during Phase 0. The platform needs explicit contracts before Browser Agent, streaming, Windows app, or Native Messaging work begins.

## Decision

- The platform has three separate planes: control, realtime input, and media.
- One container represents one Chromium endpoint.
- The extension is not responsible for streaming video.
- Browser Agent is not implemented in Phase 0.
- Arbitrary JavaScript execution and remote shell commands are not allowed platform capabilities.
- Public listeners are forbidden by default.

## Consequences

Phase 0 can add schemas, pure parsing, deterministic workflow metadata, documentation, and tests without opening network listeners or changing extension behavior.
