# Controller Core

## Internal API

Create a core with:

```js
import { ControllerCore } from '../platform/controller-core/src/controllerCore.js';

const core = new ControllerCore({ store, now, id, authPolicy });
await core.load();
```

Domain services:

- `core.devices`: enroll, register, get, list, heartbeat, status update, revoke.
- `core.workflows`: put WorkflowRevision, get revision, list metadata, find by contentHash.
- `core.groups`: create, update, delete, add/remove device, list, membership snapshot.
- `core.jobs`: create dispatch plan, enqueue legacy command, lease, acknowledge, finish, cancel batch, get batch/command.
- `core.events`: append execution event, list by job, list by device.
- `core.auth`: AuthPolicy decisions over parsed AuthContext.

## State Transitions

Unified statuses are `queued`, `dispatched`, `acknowledged`, `running`, `succeeded`, `failed`, `cancelled`, and `timed_out`.

Legacy Companion `leased` maps to unified `dispatched`. Terminal statuses cannot transition back to non-terminal states. Duplicate equivalent terminal events are idempotent; conflicting terminal data is rejected.

## Persistence

Controller Core uses `PersistenceAdapter` around the current store. JSON persistence remains the active implementation. Store state has `schemaVersion` and `controllerCore.migrationVersion`. File migration creates a backup before writing; corrupt files are copied aside and surfaced as `STORE_CORRUPT`.

## Compatibility Mapping

Companion HTTP keeps existing paths, request shapes, response shapes, status codes, token behavior, allowlist behavior, and dashboard behavior. The HTTP adapter parses request data and tokens, then calls Controller Core.

## Error Codes

Stable domain codes include `DEVICE_NOT_FOUND`, `DEVICE_REVOKED`, `WORKFLOW_NOT_FOUND`, `WORKFLOW_HASH_MISMATCH`, `GROUP_NOT_FOUND`, `INVALID_TARGET`, `DUPLICATE_JOB`, `JOB_TERMINAL`, `JOB_EXPIRED`, `INVALID_TRANSITION`, `AUTH_DENIED`, `STORE_CORRUPT`, and `CAPACITY_EXCEEDED`.

## Future Integration Points

Outbound Agent WSS and Electron Controller should call Controller Core services directly instead of reaching through HTTP route handlers. Pairing identity should plug into AuthPolicy and DeviceRegistry without changing Companion compatibility routes.

Electron Controller now calls Controller Core through the main-process application service. Renderer code cannot access Controller Core, persistence, WSS sockets, generation/session metadata, content hashes, lease IDs, or idempotency keys directly. Electron dispatch persists a Controller Core job and reports transport state separately from execution state.

Full Controller-to-Extension workflow execution remains a later downlink/E2E milestone.

## Test Strategy

Core tests cover independence, injected clock/id/random, devices, workflows, groups, jobs, execution events, dataset assignment, persistence/migration/recovery, and Companion HTTP compatibility behavior.
