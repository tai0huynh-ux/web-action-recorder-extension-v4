# Protocol v2

Protocol version: `war-control.v2`

## Component Roles

- Browser Agent: authoritative endpoint/device identity and capability reporter.
- Extension: local workflow execution component inside a Browser Agent endpoint.
- Controller: future dispatch and orchestration authority.
- Companion: legacy compatibility path for polling and scheduling.
- Native bridge: future local bridge contract, not runtime transport in this milestone.

## Envelope

Every envelope has:

- `protocolVersion`
- `messageId`
- `type`
- `sentAt`
- `payload`

Optional fields are `correlationId`, `deviceId`, `jobId`, `deadline`, `idempotencyKey`, and `sessionId`.

Unknown top-level properties, unknown message types, wrong protocol versions, invalid timestamps, oversized strings, and oversized arrays are rejected. Mutating commands require `deadline`; dispatch commands require `idempotencyKey`.

## Message Types

- `agent.hello`
- `agent.presence`
- `agent.execution.event`
- `controller.dispatch.create`
- `controller.job.cancel`
- `native.bridge.request`
- `native.bridge.response`
- `pairing.request`
- `pairing.result`

## DeviceDescriptor

Required fields: `deviceId`, `displayName`, `hostName`, `platform`, `architecture`, `agentVersion`, `extensionVersion`, `browserVersion`, `protocolVersion`, `capabilities`, `labels`, `groupIds`, `status`, `lastSeenAt`.

Capabilities include `workflowExecution`, `semanticControl`, `rawViewportInput`, `rawBrowserInput`, `nativeX11Input`, `screenshot`, `remoteVideo`, `clipboardText`, and `synchronizedInput`. Unsupported future features are represented as `false`.

## WorkflowRevision

Required fields: `workflowId`, `revision`, `schemaVersion`, `contentHash`, `name`, `description`, `createdAt`, `updatedAt`, `sourceDeviceId`, `requiredInputs`, and `profilePayload`.

`revision` is a positive integer. `contentHash` is deterministic over canonical workflow content and excludes runtime metadata. `profilePayload` is compatible with the current Extension profile shape, strips runtime-only state, and does not contain plaintext sensitive step values.

## InputDefinition

Required fields: `name`, `label`, `index`, `required`, and `sensitive`.

`defaultValue` is allowed only when `sensitive` is false. Duplicate names, duplicate indexes, negative indexes, and excessive names/defaults are rejected.

## Dispatch And Jobs

`DispatchPlan` contains `dispatchPlanId`, `createdAt`, `assignments`, `targetSnapshot`, `executionPolicy`, and `inputBatchMetadata`.

`DispatchAssignment` supports `deviceIds`, `groupIds`, `allDevices`, `workflowId`, `workflowRevision`, `workflowContentHash`, and per-target `inputMapping`.

Execution job statuses are:

- `queued`
- `dispatched`
- `acknowledged`
- `running`
- `succeeded`
- `failed`
- `cancelled`
- `timed_out`

Execution event types include job, step, log, and progress events.

## Validation Boundaries

The runtime validator is intentionally small and specialized to the project contracts. It does not introduce a full JSON Schema engine. It rejects invalid protocol version, invalid type, empty IDs, invalid timestamp, oversized values, duplicate input definitions, invalid statuses, negative revision/index values, sensitive plaintext defaults, missing mutating deadlines, missing dispatch idempotency keys, and unknown envelope top-level properties.

## Versioning Policy

Protocol v2 is additive only within `war-control.v2`. Breaking changes require a new protocolVersion and adapter compatibility notes.

## Compatibility Policy

The legacy Companion polling path remains supported by adapters. Companion `leased` maps to unified job status `dispatched`; `timeout` maps to `timed_out`. The Companion scheduler runtime is unchanged.

## Example

```json
{
  "protocolVersion": "war-control.v2",
  "messageId": "msg-1",
  "type": "controller.dispatch.create",
  "sentAt": "2026-07-16T00:00:00.000Z",
  "deadline": "2026-07-16T00:05:00.000Z",
  "idempotencyKey": "dispatch-1",
  "payload": {
    "dispatchPlanId": "plan-1",
    "createdAt": "2026-07-16T00:00:00.000Z",
    "assignments": [
      {
        "deviceIds": ["dev-a"],
        "groupIds": [],
        "allDevices": false,
        "workflowId": "wf-login",
        "workflowRevision": 1,
        "workflowContentHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "inputMapping": { "account": "field-0" }
      }
    ],
    "targetSnapshot": { "deviceIds": ["dev-a"] },
    "executionPolicy": { "maxAttempts": 1 },
    "inputBatchMetadata": { "fieldCount": 1 }
  }
}
```
