export const PROTOCOL_VERSION = 'war-control.v2';

export const DEVICE_CAPABILITY_KEYS = Object.freeze([
  'workflowExecution',
  'semanticControl',
  'rawViewportInput',
  'rawBrowserInput',
  'nativeX11Input',
  'screenshot',
  'remoteVideo',
  'clipboardText',
  'synchronizedInput'
]);

export const PRESENCE_STATUSES = Object.freeze(['online', 'offline', 'degraded', 'reconnecting']);
export const EXECUTION_JOB_STATUSES = Object.freeze([
  'queued',
  'dispatched',
  'acknowledged',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
]);

export const EXECUTION_EVENT_TYPES = Object.freeze([
  'job_acknowledged',
  'job_started',
  'step_started',
  'step_succeeded',
  'step_failed',
  'job_succeeded',
  'job_failed',
  'job_cancelled',
  'job_timed_out',
  'log',
  'progress'
]);

export const MESSAGE_TYPES = Object.freeze([
  'agent.hello',
  'agent.presence',
  'agent.execution.event',
  'bridge.hello',
  'bridge.welcome',
  'bridge.health',
  'bridge.health.request',
  'workflow.upload',
  'workflow.upload.result',
  'workflow.list',
  'workflow.list.result',
  'workflow.get',
  'workflow.get.result',
  'execution.dispatch',
  'execution.cancel',
  'execution.event',
  'execution.result',
  'execution.cancelled',
  'emergency.stop',
  'emergency.stop.ack',
  'controller.dispatch.create',
  'controller.job.cancel',
  'native.bridge.request',
  'native.bridge.response',
  'pairing.request',
  'pairing.result'
]);

const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 256;
const MAX_LABELS = 64;
const MAX_GROUPS = 64;
const MAX_ASSIGNMENTS = 512;
const MUTATING_TYPES = new Set([
  'controller.dispatch.create',
  'controller.job.cancel',
  'native.bridge.request',
  'pairing.request',
  'workflow.upload',
  'execution.dispatch',
  'execution.cancel',
  'execution.event',
  'execution.result',
  'execution.cancelled',
  'emergency.stop',
  'emergency.stop.ack'
]);
const DISPATCH_TYPES = new Set(['controller.dispatch.create']);
const COMMON_ENVELOPE_KEYS = new Set([
  'protocolVersion',
  'messageId',
  'type',
  'sentAt',
  'payload',
  'correlationId',
  'deviceId',
  'jobId',
  'deadline',
  'idempotencyKey',
  'sessionId'
]);

export function validateAgentEnvelope(envelope) {
  return validateEnvelope(envelope, { expectedTypes: ['agent.hello', 'agent.presence', 'agent.execution.event'] });
}

export function validateControllerEnvelope(envelope) {
  return validateEnvelope(envelope, { expectedTypes: ['controller.dispatch.create', 'controller.job.cancel'] });
}

export function validateNativeBridgeEnvelope(envelope) {
  return validateEnvelope(envelope, {
    expectedTypes: [
      'native.bridge.request',
      'native.bridge.response',
      'bridge.hello',
      'bridge.welcome',
      'bridge.health',
      'bridge.health.request',
      'workflow.upload',
      'workflow.upload.result',
      'workflow.list',
      'workflow.list.result',
      'workflow.get',
      'workflow.get.result',
      'execution.dispatch',
      'execution.cancel',
      'execution.event',
      'execution.result',
      'execution.cancelled',
      'emergency.stop',
      'emergency.stop.ack'
    ]
  });
}

export function validateEnvelope(envelope, options = {}) {
  const errors = [];
  if (!isPlainObject(envelope)) return result(error(errors, '$', 'Envelope must be an object.'));
  rejectUnknownKeys(envelope, COMMON_ENVELOPE_KEYS, '$', errors);
  requireString(envelope, 'protocolVersion', '$.protocolVersion', errors, { expected: PROTOCOL_VERSION });
  requireString(envelope, 'messageId', '$.messageId', errors);
  requireString(envelope, 'type', '$.type', errors);
  requireIsoUtc(envelope.sentAt, '$.sentAt', errors);
  requirePlainObject(envelope.payload, '$.payload', errors);
  for (const key of ['correlationId', 'deviceId', 'jobId', 'sessionId']) optionalString(envelope[key], `$.${key}`, errors);
  if (envelope.deadline !== undefined) requireIsoUtc(envelope.deadline, '$.deadline', errors);
  optionalString(envelope.idempotencyKey, '$.idempotencyKey', errors);

  if (typeof envelope.type === 'string') {
    if (!MESSAGE_TYPES.includes(envelope.type)) error(errors, '$.type', 'Unknown message type.');
    if (options.expectedTypes && !options.expectedTypes.includes(envelope.type)) error(errors, '$.type', 'Message type is not valid for this envelope.');
    if (MUTATING_TYPES.has(envelope.type) && !envelope.deadline) error(errors, '$.deadline', 'Mutating command requires a deadline.');
    if (DISPATCH_TYPES.has(envelope.type) && !envelope.idempotencyKey) error(errors, '$.idempotencyKey', 'Dispatch requires an idempotencyKey.');
  }

  if (envelope.type === 'agent.hello') validateAgentHelloPayload(envelope.payload, '$.payload', errors);
  if (envelope.type === 'agent.presence') validatePresenceEvent(envelope.payload, '$.payload', errors);
  if (envelope.type === 'agent.execution.event') validateExecutionEvent(envelope.payload, '$.payload', errors);
  if (envelope.type === 'workflow.upload') validateWorkflowUploadPayload(envelope.payload, '$.payload', errors);
  if (envelope.type === 'workflow.get') validateWorkflowGetPayload(envelope.payload, '$.payload', errors);
  if (envelope.type === 'execution.dispatch') validateExecutionDispatchPayload(envelope.payload, '$.payload', errors);
  if (envelope.type === 'execution.event' || envelope.type === 'execution.result' || envelope.type === 'execution.cancelled') validateExecutionEvent(envelope.payload, '$.payload', errors);
  if (envelope.type === 'controller.dispatch.create') validateDispatchPlan(envelope.payload, '$.payload', errors);
  if (envelope.type === 'pairing.request') validatePairingRequest(envelope.payload, '$.payload', errors);
  if (envelope.type === 'pairing.result') validatePairingResult(envelope.payload, '$.payload', errors);
  validateLimits(envelope, '$', errors);
  return result(errors);
}

export function validateDeviceDescriptor(value, path = '$') {
  const errors = [];
  validateDeviceDescriptorInto(value, path, errors);
  return result(errors);
}

export function validateInputDefinitions(definitions, path = '$') {
  const errors = [];
  validateInputDefinitionsInto(definitions, path, errors);
  return result(errors);
}

export function validateWorkflowRevision(value, path = '$') {
  const errors = [];
  validateWorkflowRevisionInto(value, path, errors);
  return result(errors);
}

export function validateExecutionJob(job, path = '$') {
  const errors = [];
  if (!isPlainObject(job)) return result(error(errors, path, 'ExecutionJob must be an object.'));
  for (const key of ['jobId', 'dispatchPlanId', 'deviceId', 'workflowId', 'idempotencyKey']) requireString(job, key, `${path}.${key}`, errors);
  requirePositiveInteger(job.workflowRevision, `${path}.workflowRevision`, errors);
  requirePositiveInteger(job.attempt, `${path}.attempt`, errors, { allowZero: true });
  if (!EXECUTION_JOB_STATUSES.includes(job.status)) error(errors, `${path}.status`, 'Invalid execution status.');
  for (const key of ['queuedAt', 'dispatchedAt', 'acknowledgedAt', 'startedAt', 'completedAt', 'deadline']) {
    if (job[key] !== undefined) requireIsoUtc(job[key], `${path}.${key}`, errors);
  }
  optionalString(job.lastStepId, `${path}.lastStepId`, errors);
  if (job.error !== undefined && !isPlainObject(job.error)) error(errors, `${path}.error`, 'error must be an object.');
  validateLimits(job, path, errors);
  return result(errors);
}

function validateAgentHelloPayload(payload, path, errors) {
  if (!isPlainObject(payload)) return;
  requireString(payload, 'protocolVersion', `${path}.protocolVersion`, errors, { expected: PROTOCOL_VERSION });
  validateDeviceDescriptorInto(payload.device, `${path}.device`, errors);
  requireStringArray(payload.supportedMessageTypes, `${path}.supportedMessageTypes`, errors);
  for (const [index, type] of (payload.supportedMessageTypes || []).entries()) {
    if (!MESSAGE_TYPES.includes(type)) error(errors, `${path}.supportedMessageTypes[${index}]`, 'Unknown supported message type.');
  }
  requireString(payload, 'sessionNonce', `${path}.sessionNonce`, errors);
  requireIsoUtc(payload.sentAt, `${path}.sentAt`, errors);
}

function validateDeviceDescriptorInto(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'DeviceDescriptor must be an object.');
  for (const key of ['deviceId', 'displayName', 'hostName', 'platform', 'architecture', 'agentVersion', 'extensionVersion', 'browserVersion', 'protocolVersion', 'status', 'lastSeenAt']) {
    requireString(value, key, `${path}.${key}`, errors);
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) error(errors, `${path}.protocolVersion`, `protocolVersion must be ${PROTOCOL_VERSION}.`);
  if (!PRESENCE_STATUSES.includes(value.status)) error(errors, `${path}.status`, 'Invalid presence status.');
  requireIsoUtc(value.lastSeenAt, `${path}.lastSeenAt`, errors);
  validateCapabilities(value.capabilities, `${path}.capabilities`, errors);
  requireStringArray(value.labels, `${path}.labels`, errors, { maxItems: MAX_LABELS });
  requireStringArray(value.groupIds, `${path}.groupIds`, errors, { maxItems: MAX_GROUPS });
}

function validateCapabilities(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'capabilities must be an object.');
  for (const key of Object.keys(value)) {
    if (!DEVICE_CAPABILITY_KEYS.includes(key)) error(errors, `${path}.${key}`, 'Unknown capability.');
  }
  for (const key of DEVICE_CAPABILITY_KEYS) {
    if (typeof value[key] !== 'boolean') error(errors, `${path}.${key}`, 'Capability must be boolean.');
  }
}

function validatePresenceEvent(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'PresenceEvent must be an object.');
  requireString(value, 'deviceId', `${path}.deviceId`, errors);
  if (!PRESENCE_STATUSES.includes(value.status)) error(errors, `${path}.status`, 'Invalid presence status.');
  requireIsoUtc(value.lastSeenAt, `${path}.lastSeenAt`, errors);
}

function validateWorkflowRevisionInto(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'WorkflowRevision must be an object.');
  for (const key of ['workflowId', 'schemaVersion', 'contentHash', 'name', 'createdAt', 'updatedAt', 'sourceDeviceId']) {
    requireString(value, key, `${path}.${key}`, errors);
  }
  optionalString(value.description, `${path}.description`, errors);
  requirePositiveInteger(value.revision, `${path}.revision`, errors);
  if (typeof value.contentHash === 'string' && !/^[a-f0-9]{64}$/.test(value.contentHash)) error(errors, `${path}.contentHash`, 'contentHash must be a sha256 hex string.');
  requireIsoUtc(value.createdAt, `${path}.createdAt`, errors);
  requireIsoUtc(value.updatedAt, `${path}.updatedAt`, errors);
  validateInputDefinitionsInto(value.requiredInputs, `${path}.requiredInputs`, errors);
  if (!isPlainObject(value.profilePayload)) error(errors, `${path}.profilePayload`, 'profilePayload must be an object.');
  validateNoPlaintextSensitiveDefaults(value.requiredInputs, `${path}.requiredInputs`, errors);
  validateLimits(value, path, errors);
}

function validateInputDefinitionsInto(definitions, path, errors) {
  if (!Array.isArray(definitions)) return error(errors, path, 'InputDefinition list must be an array.');
  if (definitions.length > MAX_ARRAY_LENGTH) error(errors, path, `Array exceeds max length ${MAX_ARRAY_LENGTH}.`);
  const names = new Set();
  const indexes = new Set();
  definitions.forEach((definition, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(definition)) return error(errors, itemPath, 'InputDefinition must be an object.');
    requireString(definition, 'name', `${itemPath}.name`, errors);
    optionalString(definition.label, `${itemPath}.label`, errors);
    requirePositiveInteger(definition.index, `${itemPath}.index`, errors, { allowZero: true });
    if (typeof definition.required !== 'boolean') error(errors, `${itemPath}.required`, 'required must be boolean.');
    if (typeof definition.sensitive !== 'boolean') error(errors, `${itemPath}.sensitive`, 'sensitive must be boolean.');
    if (typeof definition.name === 'string') {
      if (names.has(definition.name)) error(errors, `${itemPath}.name`, 'Duplicate input name.');
      names.add(definition.name);
    }
    if (Number.isInteger(definition.index)) {
      if (indexes.has(definition.index)) error(errors, `${itemPath}.index`, 'Duplicate input index.');
      indexes.add(definition.index);
    }
    if (definition.sensitive && Object.prototype.hasOwnProperty.call(definition, 'defaultValue')) {
      error(errors, `${itemPath}.defaultValue`, 'Sensitive input cannot carry a plaintext defaultValue.');
    }
    if (definition.defaultValue !== undefined && typeof definition.defaultValue === 'string' && definition.defaultValue.length > MAX_STRING_LENGTH) {
      error(errors, `${itemPath}.defaultValue`, `String exceeds max length ${MAX_STRING_LENGTH}.`);
    }
  });
}

function validateNoPlaintextSensitiveDefaults(definitions, path, errors) {
  if (!Array.isArray(definitions)) return;
  definitions.forEach((definition, index) => {
    if (definition?.sensitive && definition.defaultValue !== undefined) error(errors, `${path}[${index}].defaultValue`, 'Sensitive input cannot carry a plaintext defaultValue.');
  });
}

function validateDispatchPlan(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'DispatchPlan must be an object.');
  requireString(value, 'dispatchPlanId', `${path}.dispatchPlanId`, errors);
  requireIsoUtc(value.createdAt, `${path}.createdAt`, errors);
  requireArray(value.assignments, `${path}.assignments`, errors, { maxItems: MAX_ASSIGNMENTS });
  for (const [index, assignment] of (value.assignments || []).entries()) validateDispatchAssignment(assignment, `${path}.assignments[${index}]`, errors);
  if (!isPlainObject(value.targetSnapshot)) error(errors, `${path}.targetSnapshot`, 'targetSnapshot must be an object.');
  if (!isPlainObject(value.executionPolicy)) error(errors, `${path}.executionPolicy`, 'executionPolicy must be an object.');
  if (!isPlainObject(value.inputBatchMetadata)) error(errors, `${path}.inputBatchMetadata`, 'inputBatchMetadata must be an object.');
}

function validateDispatchAssignment(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'DispatchAssignment must be an object.');
  requireStringArray(value.deviceIds || [], `${path}.deviceIds`, errors);
  requireStringArray(value.groupIds || [], `${path}.groupIds`, errors);
  if (value.allDevices !== undefined && typeof value.allDevices !== 'boolean') error(errors, `${path}.allDevices`, 'allDevices must be boolean.');
  requireString(value, 'workflowId', `${path}.workflowId`, errors);
  requirePositiveInteger(value.workflowRevision, `${path}.workflowRevision`, errors);
  requireString(value, 'workflowContentHash', `${path}.workflowContentHash`, errors);
  if (!isPlainObject(value.inputMapping)) error(errors, `${path}.inputMapping`, 'inputMapping must be an object.');
}

function validateExecutionEvent(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'ExecutionEvent must be an object.');
  if (!EXECUTION_EVENT_TYPES.includes(value.eventType)) error(errors, `${path}.eventType`, 'Invalid execution event type.');
  requireString(value, 'jobId', `${path}.jobId`, errors);
  requireIsoUtc(value.sentAt, `${path}.sentAt`, errors);
  optionalString(value.stepId, `${path}.stepId`, errors);
  optionalString(value.message, `${path}.message`, errors);
}

function validateWorkflowUploadPayload(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'workflow.upload payload must be an object.');
  validateWorkflowRevisionInto(value.revision, `${path}.revision`, errors);
}

function validateWorkflowGetPayload(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'workflow.get payload must be an object.');
  requireString(value, 'workflowId', `${path}.workflowId`, errors);
  requirePositiveInteger(value.revision, `${path}.revision`, errors);
}

function validateExecutionDispatchPayload(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'execution.dispatch payload must be an object.');
  for (const key of ['jobId', 'workflowId', 'workflowContentHash', 'idempotencyKey']) requireString(value, key, `${path}.${key}`, errors);
  requirePositiveInteger(value.workflowRevision, `${path}.workflowRevision`, errors);
  requireIsoUtc(value.deadline, `${path}.deadline`, errors);
  if (!isPlainObject(value.inputs || {})) error(errors, `${path}.inputs`, 'inputs must be an object.');
  if (value.controlPath !== undefined && !['legacy_companion', 'native_bridge'].includes(value.controlPath)) error(errors, `${path}.controlPath`, 'Invalid controlPath.');
}

function validatePairingRequest(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'PairingRequest must be an object.');
  requireString(value, 'requestId', `${path}.requestId`, errors);
  requireString(value, 'displayName', `${path}.displayName`, errors);
  requireIsoUtc(value.requestedAt, `${path}.requestedAt`, errors);
}

function validatePairingResult(value, path, errors) {
  if (!isPlainObject(value)) return error(errors, path, 'PairingResult must be an object.');
  requireString(value, 'requestId', `${path}.requestId`, errors);
  if (typeof value.accepted !== 'boolean') error(errors, `${path}.accepted`, 'accepted must be boolean.');
  requireIsoUtc(value.decidedAt, `${path}.decidedAt`, errors);
}

function validateLimits(value, path, errors) {
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) error(errors, path, `String exceeds max length ${MAX_STRING_LENGTH}.`);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) error(errors, path, `Array exceeds max length ${MAX_ARRAY_LENGTH}.`);
    value.forEach((item, index) => validateLimits(item, `${path}[${index}]`, errors));
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) validateLimits(child, `${path}.${key}`, errors);
  }
}

function requireString(object, key, path, errors, options = {}) {
  const value = object?.[key];
  if (typeof value !== 'string' || value.length === 0) return error(errors, path, 'Required string is missing or empty.');
  if (value.length > MAX_STRING_LENGTH) error(errors, path, `String exceeds max length ${MAX_STRING_LENGTH}.`);
  if (options.expected !== undefined && value !== options.expected) error(errors, path, `Value must be ${options.expected}.`);
}

function optionalString(value, path, errors) {
  if (value === undefined) return;
  if (typeof value !== 'string') return error(errors, path, 'Value must be a string.');
  if (value.length > MAX_STRING_LENGTH) error(errors, path, `String exceeds max length ${MAX_STRING_LENGTH}.`);
}

function requirePositiveInteger(value, path, errors, options = {}) {
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) error(errors, path, `Value must be an integer >= ${minimum}.`);
}

function requireIsoUtc(value, path, errors) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    error(errors, path, 'Timestamp must be ISO-8601 UTC.');
  }
}

function requireStringArray(value, path, errors, options = {}) {
  requireArray(value, path, errors, options);
  if (!Array.isArray(value)) return;
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.length === 0) error(errors, `${path}[${index}]`, 'Array item must be a non-empty string.');
  });
}

function requireArray(value, path, errors, options = {}) {
  if (!Array.isArray(value)) return error(errors, path, 'Value must be an array.');
  const maxItems = options.maxItems ?? MAX_ARRAY_LENGTH;
  if (value.length > maxItems) error(errors, path, `Array exceeds max length ${maxItems}.`);
}

function requirePlainObject(value, path, errors) {
  if (!isPlainObject(value)) error(errors, path, 'Value must be an object.');
}

function rejectUnknownKeys(value, allowedKeys, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) error(errors, `${path}.${key}`, 'Unknown top-level property.');
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function error(errors, path, message) {
  errors.push({ path, message });
  return errors;
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}
