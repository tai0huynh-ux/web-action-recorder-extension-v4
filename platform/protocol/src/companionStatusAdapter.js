import { EXECUTION_JOB_STATUSES } from './protocolV2.js';

const COMPANION_STATUS_TO_EXECUTION = new Map([
  ['queued', 'queued'],
  ['leased', 'dispatched'],
  ['running', 'running'],
  ['succeeded', 'succeeded'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['timeout', 'timed_out'],
  ['timed_out', 'timed_out']
]);

export function mapCompanionStatusToExecutionJobStatus(status) {
  const normalized = COMPANION_STATUS_TO_EXECUTION.get(String(status || '').toLowerCase());
  if (!normalized) {
    throw new Error(`Unsupported companion status: ${String(status || 'unknown')}`);
  }
  return normalized;
}

export function createExecutionJobFromCompanionCommand(command, overrides = {}) {
  const status = mapCompanionStatusToExecutionJobStatus(command?.status);
  const now = overrides.now ?? new Date().toISOString();
  return {
    jobId: command.id,
    dispatchPlanId: command.batchId ?? overrides.dispatchPlanId ?? 'legacy-dispatch',
    deviceId: command.deviceId,
    workflowId: command.profileId,
    workflowRevision: overrides.workflowRevision ?? 1,
    status,
    attempt: Number(command.attempt ?? 0),
    idempotencyKey: command.idempotencyKey ?? command.id,
    queuedAt: command.notBefore ?? command.createdAt ?? now,
    dispatchedAt: command.leaseUntil ? command.notBefore ?? now : undefined,
    acknowledgedAt: status === 'running' ? command.notBefore ?? now : undefined,
    startedAt: status === 'running' ? command.notBefore ?? now : undefined,
    completedAt: command.completedAt,
    deadline: command.deadline ?? command.leaseUntil,
    lastStepId: command.lastStepId,
    error: command.error ? { message: String(command.error) } : undefined
  };
}
