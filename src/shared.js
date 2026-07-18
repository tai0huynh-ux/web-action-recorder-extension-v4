export const STORAGE_KEYS = {
  profiles: 'war_profiles',
  activeProfileId: 'war_active_profile_id',
  logs: 'war_logs',
  library: 'war_library',
  settings: 'war_settings',
  controllerTerminalOutbox: 'war_controller_terminal_outbox'
};

export const PROFILE_SCHEMA_VERSION = 1;
export const DEFAULT_SETTINGS = {
  globalWatcherEnabled: false,
  externalApiEnabled: false,
  companionUrl: 'http://127.0.0.1:17373',
  companionToken: '',
  companionEnrollmentToken: '',
  companionDeviceId: '',
  companionDeviceName: '',
  companionPollMs: 2000,
  legacyCompanionPollingEnabled: true,
  nativeBridgeEnabled: true,
  nativeHostName: 'com.web_action_recorder.native_bridge'
};

export const STEP_TYPES = new Set(['click', 'type', 'shortcut', 'navigate', 'switchTab', 'log', 'condition', 'OR', 'AND', 'IFS']);

export const SAFE_SHORTCUTS = new Set(['CTRL+A', 'CTRL+C']);

export function normalizeShortcut(keys) {
  const list = Array.isArray(keys) ? keys : String(keys || '').split('+');
  const normalized = list.map((key) => String(key).trim().toUpperCase()).filter(Boolean);
  if (!normalized.length || normalized.length !== list.length || normalized.length > 3) throw new Error('Shortcut khong hop le');
  return normalized.join('+');
}

export function validateSafeShortcut(keys) {
  const shortcut = normalizeShortcut(keys);
  if (!SAFE_SHORTCUTS.has(shortcut)) throw new Error(`Shortcut khong duoc ho tro: ${shortcut}`);
  return shortcut;
}

export const SAMPLE_PROFILE = {
  id: 'sample-login-search',
  name: 'Sample: Domain check then search',
  enabled: false,
  allowHighRisk: false,
  steps: [
    { id: 's1', name: 'Check current domain', type: 'condition', delayAfterMs: 500, condition: { kind: 'domain', operator: 'contains', value: '*' }, ifSteps: ['s2'], elseSteps: ['s4'] },
    { id: 's2', name: 'Click search field', type: 'click', delayAfterMs: 300, selector: 'input[type="search"], input[name="q"], textarea[name="q"]' },
    { id: 's3', name: 'Type example query', type: 'type', delayAfterMs: 800, selector: 'input[type="search"], input[name="q"], textarea[name="q"]', text: 'OpenClaw web automation' },
    { id: 's4', name: 'Log unmatched domain', type: 'log', delayAfterMs: 0, message: 'Domain condition did not match.' }
  ]
};

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeProfile(profile) {
  const next = { ...clone(profile), steps: Array.isArray(profile?.steps) ? clone(profile.steps) : [] };
  next.id ||= uid('profile');
  next.name ||= 'Untitled profile';
  next.enabled = Boolean(next.enabled);
  next.allowHighRisk = Boolean(next.allowHighRisk);
  next.schemaVersion = PROFILE_SCHEMA_VERSION;
  next.steps = next.steps.map((step, index) => ({
    id: step.id || uid('step'),
    name: step.name || `Step ${index + 1}`,
    type: step.type || 'click',
    delayAfterMs: Number(step.delayAfterMs || 0),
    ...step
  }));
  return next;
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Profile phải là một JSON object');
  if (typeof profile.name !== 'string' || !profile.name.trim()) throw new Error('Profile thiếu tên hợp lệ');
  if (!Array.isArray(profile.steps)) throw new Error('Profile.steps phải là một array');
  if (profile.steps.length > 500) throw new Error('Profile vượt quá giới hạn 500 bước');
  const ids = new Set();
  for (const [index, step] of profile.steps.entries()) {
    if (!step || typeof step !== 'object') throw new Error(`Bước ${index + 1} không hợp lệ`);
    if (!STEP_TYPES.has(step.type || 'click')) throw new Error(`Loại bước không được hỗ trợ: ${step.type}`);
    if (step.type === 'shortcut') validateSafeShortcut(step.keys || step.shortcut);
    if (step.id && ids.has(step.id)) throw new Error(`Trùng step id: ${step.id}`);
    if (step.id) ids.add(step.id);
    if (Number(step.delayAfterMs || 0) < 0 || Number(step.delayAfterMs || 0) > 3600000) throw new Error(`Delay không hợp lệ ở bước ${index + 1}`);
  }
  return true;
}

export function wildcardToRegExp(pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function isSupportedRunUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeSwitchTabPattern(pattern) {
  const value = String(pattern || '').trim();
  if (!value) throw new Error('Switch Tab pattern is empty');
  return value;
}

export function matchesSwitchTabPattern(tab, pattern) {
  const value = normalizeSwitchTabPattern(pattern);
  if (!isSupportedRunUrl(tab?.url)) return false;
  const haystacks = [tab?.url || '', tab?.title || ''];
  if (!value.includes('*')) {
    const needle = value.toLowerCase();
    return haystacks.some((item) => String(item).toLowerCase().includes(needle));
  }
  const re = wildcardToRegExp(value);
  return haystacks.some((item) => re.test(String(item || '')));
}

export function matchesText(actual, operator, expected) {
  const a = String(actual || '');
  const e = String(expected || '');
  if (operator === 'equals') return a === e;
  if (operator === 'matches') return wildcardToRegExp(e).test(a);
  return a.toLowerCase().includes(e.replaceAll('*', '').toLowerCase());
}

export function redactStepForLog(step) {
  if (step?.type !== 'type') return step;
  const looksSecret = /password|passwd|token|secret|otp|pin/i.test(`${step.selector || ''} ${step.name || ''}`);
  return looksSecret ? { ...step, text: '[redacted]' } : step;
}
