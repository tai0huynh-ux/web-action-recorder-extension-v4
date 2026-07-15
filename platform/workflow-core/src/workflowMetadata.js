import { createHash } from 'node:crypto';

const HASH_EXCLUDED_KEYS = new Set([
  'contentHash',
  'createdAt',
  'updatedAt',
  'revision',
  'sourceDeviceId'
]);

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
