const SECRET_KEY_RE = /password|passwd|token|secret|otp|pin|api[_-]?key|authorization/i;
const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function resolveTemplate(value, inputs = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(TEMPLATE_RE, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
      throw new Error(`Missing input: ${key}`);
    }
    return String(inputs[key] ?? '');
  });
}

export function resolveStepTemplates(step, inputs = {}) {
  const next = { ...step };
  for (const key of ['text', 'url', 'selector', 'message', 'tabName']) {
    if (typeof next[key] === 'string') next[key] = resolveTemplate(next[key], inputs);
  }
  if (next.condition) next.condition = resolveConditionTemplate(next.condition, inputs);
  if (Array.isArray(next.conditions)) next.conditions = next.conditions.map((condition) => resolveConditionTemplate(condition, inputs));
  return next;
}

export function resolveConditionTemplate(condition, inputs = {}) {
  const next = { ...condition };
  for (const key of ['selector', 'value']) {
    if (typeof next[key] === 'string') next[key] = resolveTemplate(next[key], inputs);
  }
  return next;
}

export function redactValue(key, value) {
  if (SECRET_KEY_RE.test(String(key || ''))) return '[redacted]';
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 240)}...`;
  return value;
}

export function redactObject(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactObject);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(key, redactObject(item))]));
}
