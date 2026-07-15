export class AuditService {
  constructor({ store, now }) {
    this.store = store;
    this.now = now;
  }

  append(state, type, details = {}) {
    state.auditEvents ||= [];
    const event = {
      sequence: state.auditEvents.length + 1,
      type,
      at: this.now(),
      details: redact(details)
    };
    state.auditEvents.push(event);
    if (state.auditEvents.length > 1000) state.auditEvents = state.auditEvents.slice(-1000);
    return event;
  }
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /token|secret|password|credential|private.?key/i.test(key) ? '[REDACTED]' : redact(child)
  ]));
}
