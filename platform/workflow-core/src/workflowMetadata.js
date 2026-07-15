import { createHash } from 'node:crypto';

const HASH_EXCLUDED_KEYS = new Set([
  'contentHash',
  'createdAt',
  'updatedAt',
  'revision',
  'sourceDeviceId'
]);

const PROFILE_RUNTIME_KEYS = new Set([
  'activeRunId',
  'currentStepId',
  'isRoot',
  'lastError',
  'lastRunAt',
  'lastStepId',
  'leaseId',
  'leaseUntil',
  'runId',
  'runState',
  'runtime',
  'status'
]);

const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
const SECRET_RE = /password|passwd|passcode|token|secret|otp|2fa|mfa|pin|cvv|credit.?card|api.?key|authorization/i;
export const WORKFLOW_REVISION_SCHEMA_VERSION = 'war-workflow-revision.v2';

export function canonicalizeWorkflowMetadata(metadata) {
  return stableClone(metadata, HASH_EXCLUDED_KEYS);
}

export function createWorkflowContentHash(metadata) {
  const canonical = canonicalizeWorkflowMetadata(metadata);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createWorkflowRevisionMetadata(metadata) {
  const now = metadata.updatedAt ?? metadata.createdAt ?? new Date().toISOString();
  const createdAt = metadata.createdAt ?? now;
  return {
    workflowId: metadata.workflowId,
    revision: metadata.revision,
    contentHash: metadata.contentHash ?? createWorkflowContentHash(metadata),
    name: metadata.name,
    schemaVersion: metadata.schemaVersion,
    createdAt,
    updatedAt: metadata.updatedAt ?? now,
    sourceDeviceId: metadata.sourceDeviceId,
    requiredInputs: Array.isArray(metadata.requiredInputs) ? [...metadata.requiredInputs] : []
  };
}

export function createWorkflowRevisionFromExtensionProfile(profile, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const normalizedProfile = normalizeExtensionProfilePayload(profile);
  const requiredInputs = inferInputDefinitions(normalizedProfile);
  const revisionDraft = {
    workflowId: normalizedProfile.id,
    revision: options.revision ?? 1,
    schemaVersion: WORKFLOW_REVISION_SCHEMA_VERSION,
    name: normalizedProfile.name,
    description: normalizedProfile.description ?? '',
    createdAt: options.createdAt ?? profile?.createdAt ?? now,
    updatedAt: options.updatedAt ?? profile?.updatedAt ?? now,
    sourceDeviceId: options.sourceDeviceId ?? 'unknown-device',
    requiredInputs,
    profilePayload: normalizedProfile
  };
  return {
    ...revisionDraft,
    contentHash: createWorkflowContentHash(revisionDraft)
  };
}

export function extensionProfileFromWorkflowRevision(revision) {
  if (!revision || revision.schemaVersion !== WORKFLOW_REVISION_SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow revision schemaVersion: ${revision?.schemaVersion || 'missing'}`);
  }
  if (!revision.profilePayload || typeof revision.profilePayload !== 'object' || Array.isArray(revision.profilePayload)) {
    throw new Error('WorkflowRevision.profilePayload must be an object.');
  }
  return stableClone(revision.profilePayload);
}

export function normalizeExtensionProfilePayload(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Extension profile must be an object.');
  }
  const normalized = stripRuntimeState(profile);
  normalized.id = stringOrDefault(normalized.id, 'workflow');
  normalized.name = stringOrDefault(normalized.name, 'Untitled workflow');
  normalized.schemaVersion = Number.isInteger(normalized.schemaVersion) ? normalized.schemaVersion : 1;
  normalized.enabled = Boolean(normalized.enabled);
  normalized.allowHighRisk = Boolean(normalized.allowHighRisk);
  normalized.steps = Array.isArray(normalized.steps) ? normalized.steps.map((step, index) => normalizeStep(step, index)) : [];
  return stableClone(normalized);
}

export function inferInputDefinitions(profile) {
  const definitions = [];
  const byName = new Map();
  const add = (name, source = {}) => {
    if (!name || byName.has(name)) return;
    const sensitive = Boolean(source.sensitive) || SECRET_RE.test(name);
    const definition = {
      name,
      label: source.label || labelFromName(name),
      index: definitions.length,
      required: source.required !== false,
      sensitive
    };
    if (!sensitive && source.defaultValue !== undefined) definition.defaultValue = source.defaultValue;
    definitions.push(definition);
    byName.set(name, definition);
  };

  if (Array.isArray(profile?.requiredInputs)) {
    for (const item of profile.requiredInputs) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.name, item);
    }
  }
  for (const step of Array.isArray(profile?.steps) ? profile.steps : []) {
    collectTemplateNames(step, add);
  }
  return definitions;
}

function normalizeStep(step, index) {
  const normalized = stripRuntimeState(step && typeof step === 'object' ? step : {});
  normalized.id = stringOrDefault(normalized.id, `step-${index + 1}`);
  normalized.name = stringOrDefault(normalized.name, `Step ${index + 1}`);
  normalized.type = stringOrDefault(normalized.type, 'click');
  if (isSensitiveStep(normalized)) {
    delete normalized.text;
    normalized.requiresSecretPrompt = true;
  }
  if (Array.isArray(normalized.conditions)) normalized.conditions = normalized.conditions.map((condition) => stripRuntimeState(condition));
  if (normalized.condition) normalized.condition = stripRuntimeState(normalized.condition);
  return stableClone(normalized);
}

function stripRuntimeState(value) {
  if (Array.isArray(value)) return value.map(stripRuntimeState);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .filter((key) => !PROFILE_RUNTIME_KEYS.has(key))
    .sort()
    .reduce((next, key) => {
      next[key] = stripRuntimeState(value[key]);
      return next;
    }, {});
}

function collectTemplateNames(value, add) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TEMPLATE_RE)) add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectTemplateNames(item, add));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'type' && value.requiresSecretPrompt && typeof value.name === 'string') add(slugFromName(value.name), { sensitive: true, label: value.name });
  for (const child of Object.values(value)) collectTemplateNames(child, add);
}

function isSensitiveStep(step) {
  return step?.type === 'type' && (step.requiresSecretPrompt || SECRET_RE.test(`${step.selector || ''} ${step.name || ''}`));
}

function stringOrDefault(value, fallback) {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function labelFromName(name) {
  return String(name).replace(/[_.-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugFromName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'input';
}

function stableClone(value, excludedKeys = new Set()) {
  if (Array.isArray(value)) return value.map((item) => stableClone(item, excludedKeys));
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .filter((key) => !excludedKeys.has(key))
    .sort()
    .reduce((next, key) => {
      next[key] = stableClone(value[key], excludedKeys);
      return next;
    }, {});
}
