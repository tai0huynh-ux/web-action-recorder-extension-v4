import { domainError, ERROR_CODES } from './errors.js';

export const UNIFIED_JOB_STATUSES = Object.freeze([
  'queued',
  'dispatched',
  'acknowledged',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
]);

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

const ALLOWED = new Map([
  ['queued', new Set(['dispatched', 'cancelled', 'timed_out'])],
  ['dispatched', new Set(['acknowledged', 'running', 'cancelled', 'failed', 'timed_out'])],
  ['acknowledged', new Set(['running', 'cancelled', 'failed', 'timed_out'])],
  ['running', new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])]
]);

export function assertTransition(from, to, { idempotentTerminal = true, previousResult, nextResult } = {}) {
  if (!UNIFIED_JOB_STATUSES.includes(to)) throw domainError(ERROR_CODES.INVALID_TRANSITION, `Unknown job status: ${to}`);
  if (from === to) {
    if (TERMINAL_STATUSES.has(to) && idempotentTerminal && !terminalResultsConflict(previousResult, nextResult)) return true;
    if (!TERMINAL_STATUSES.has(to)) return true;
  }
  if (TERMINAL_STATUSES.has(from)) {
    throw domainError(ERROR_CODES.JOB_TERMINAL, `Cannot transition terminal job from ${from} to ${to}`);
  }
  if (!ALLOWED.get(from)?.has(to)) throw domainError(ERROR_CODES.INVALID_TRANSITION, `Invalid job transition ${from} -> ${to}`);
  return true;
}

export function terminalResultsConflict(left, right) {
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) !== JSON.stringify(right);
}

export function companionToUnifiedStatus(status) {
  if (status === 'leased') return 'dispatched';
  if (status === 'timeout') return 'timed_out';
  return status;
}

export function unifiedToCompanionStatus(status) {
  if (status === 'dispatched') return 'leased';
  if (status === 'timed_out') return 'failed';
  return status;
}
