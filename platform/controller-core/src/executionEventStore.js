import { TERMINAL_STATUSES } from './stateTransitions.js';
import { domainError, ERROR_CODES } from './errors.js';

const SENSITIVE_RE = /password|passwd|token|secret|otp|pin|credential/i;

export class ExecutionEventStore {
  constructor({ store, now }) {
    this.store = store;
    this.now = now;
  }

  appendEvent(event, { auditOnly = false } = {}) {
    return this.store.update((state) => {
      const job = state.commands.find((item) => item.id === event.jobId);
      if (job && TERMINAL_STATUSES.has(normalizeStatus(job.status)) && !auditOnly) {
        throw domainError(ERROR_CODES.JOB_TERMINAL, 'Cannot append execution event after terminal state', 409);
      }
      const next = {
        sequence: state.executionEvents.length + 1,
        sentAt: event.sentAt || this.now(),
        ...redactEvent(event)
      };
      state.executionEvents.push(next);
      if (state.executionEvents.length > 5000) state.executionEvents = state.executionEvents.slice(-5000);
      return structuredClone(next);
    });
  }

  listByJob(jobId) {
    return this.store.snapshot().executionEvents.filter((event) => event.jobId === jobId);
  }

  listByDevice(deviceId) {
    return this.store.snapshot().executionEvents.filter((event) => event.deviceId === deviceId);
  }
}

function normalizeStatus(status) {
  if (status === 'leased') return 'dispatched';
  return status;
}

function redactEvent(value) {
  if (Array.isArray(value)) return value.map(redactEvent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    SENSITIVE_RE.test(key) ? '[REDACTED]' : redactEvent(child)
  ]));
}
