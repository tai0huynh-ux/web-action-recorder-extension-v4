import crypto from 'node:crypto';
import { buildDatasetAssignments } from '../platform/controller-core/src/datasetAssignment.js';
import { requeueExpired as coreRequeueExpired } from '../platform/controller-core/src/jobService.js';
import { assertTransition, companionToUnifiedStatus, unifiedToCompanionStatus } from '../platform/controller-core/src/stateTransitions.js';

export const COMMAND_TYPES = new Set(['run_profile', 'stop_run', 'get_state']);

export function buildAssignments({ devices, profileId, type = 'run_profile', inputs = {}, dataset = [], assignmentMode = 'same', allowDuplicate = true, seed = 'war' }) {
  return buildDatasetAssignments({ devices, inputs, dataset, assignmentMode, allowDuplicate, seed }).map((assignment) => ({
    id: crypto.randomUUID(),
    deviceId: assignment.deviceId,
    type,
    profileId,
    inputs: assignment.inputs,
    status: 'queued',
    attempt: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    notBefore: new Date().toISOString()
  }));
}

export function leaseNextCommand(state, deviceId, leaseMs = 30000) {
  const now = Date.now();
  requeueExpired(state, now);
  const command = state.commands.find((item) => item.deviceId === deviceId && item.status === 'queued' && Date.parse(item.notBefore || 0) <= now);
  if (!command) return null;
  assertTransition(companionToUnifiedStatus(command.status), 'dispatched');
  command.status = unifiedToCompanionStatus('dispatched');
  command.attempt = Number(command.attempt || 0) + 1;
  command.leaseId = crypto.randomUUID();
  command.leaseUntil = new Date(now + leaseMs).toISOString();
  command.startedAt ||= new Date(now).toISOString();
  return structuredClone(command);
}

export function ackCommand(state, deviceId, commandId, leaseId) {
  const command = findCommand(state, deviceId, commandId, leaseId);
  assertTransition(companionToUnifiedStatus(command.status), 'running');
  command.status = 'running';
  return structuredClone(command);
}

export function finishCommand(state, deviceId, commandId, leaseId, result) {
  const command = findCommand(state, deviceId, commandId, leaseId);
  const status = result?.ok === false ? 'failed' : 'succeeded';
  assertTransition(companionToUnifiedStatus(command.status), status, { previousResult: command.result, nextResult: result });
  if (['succeeded', 'failed', 'cancelled'].includes(command.status)) return structuredClone(command);
  command.status = status;
  command.result = result;
  command.completedAt = new Date().toISOString();
  state.results.push({ commandId, deviceId, result, completedAt: command.completedAt });
  return structuredClone(command);
}

export function requeueExpired(state, now = Date.now()) {
  return coreRequeueExpired(state, now);
}

function findCommand(state, deviceId, commandId, leaseId) {
  const command = state.commands.find((item) => item.id === commandId && item.deviceId === deviceId);
  if (!command) throw new Error('Command not found');
  if (command.leaseId !== leaseId) throw new Error('Lease mismatch');
  return command;
}
