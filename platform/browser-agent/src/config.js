import fs from 'node:fs';
import path from 'node:path';
import { AgentError, redact } from './errors.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 3766,
  dataDir: '/data',
  chromiumExecutable: '/usr/bin/chromium',
  extensionDir: '/app/extension',
  headless: false,
  noSandbox: false,
  width: 1366,
  height: 768,
  locale: 'en-US',
  timezone: 'UTC',
  autoStartBrowser: true,
  allowRemote: false,
  allow: []
};

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const config = {
    host: readString(env.WAR_AGENT_HOST, DEFAULTS.host),
    port: readInt(env.WAR_AGENT_PORT, DEFAULTS.port, 1, 65535, 'WAR_AGENT_PORT'),
    token: readOptionalString(env.WAR_AGENT_TOKEN),
    allowRemote: readBool(env.WAR_AGENT_ALLOW_REMOTE, DEFAULTS.allowRemote, 'WAR_AGENT_ALLOW_REMOTE'),
    allow: readList(env.WAR_AGENT_ALLOW),
    dataDir: resolvePath(env.WAR_DATA_DIR || DEFAULTS.dataDir, cwd),
    chromiumExecutable: resolvePath(env.WAR_CHROMIUM_EXECUTABLE || DEFAULTS.chromiumExecutable, cwd),
    extensionDir: resolvePath(env.WAR_EXTENSION_DIR || DEFAULTS.extensionDir, cwd),
    headless: readBool(env.WAR_BROWSER_HEADLESS, DEFAULTS.headless, 'WAR_BROWSER_HEADLESS'),
    noSandbox: readBool(env.WAR_BROWSER_NO_SANDBOX, DEFAULTS.noSandbox, 'WAR_BROWSER_NO_SANDBOX'),
    width: readInt(env.WAR_BROWSER_WIDTH, DEFAULTS.width, 320, 7680, 'WAR_BROWSER_WIDTH'),
    height: readInt(env.WAR_BROWSER_HEIGHT, DEFAULTS.height, 240, 4320, 'WAR_BROWSER_HEIGHT'),
    locale: readString(env.WAR_BROWSER_LOCALE, DEFAULTS.locale),
    timezone: readString(env.WAR_BROWSER_TIMEZONE, DEFAULTS.timezone),
    autoStartBrowser: readBool(env.WAR_AUTO_START_BROWSER, DEFAULTS.autoStartBrowser, 'WAR_AUTO_START_BROWSER'),
    maxBodyBytes: readInt(env.WAR_AGENT_MAX_BODY_BYTES, 1024 * 1024, 1024, 5 * 1024 * 1024, 'WAR_AGENT_MAX_BODY_BYTES'),
    inputMaxQueue: readInt(env.WAR_INPUT_MAX_QUEUE, 50, 1, 500, 'WAR_INPUT_MAX_QUEUE'),
    inputMaxTextLength: readInt(env.WAR_INPUT_MAX_TEXT_LENGTH, 4096, 1, 65536, 'WAR_INPUT_MAX_TEXT_LENGTH'),
    inputMaxDurationMs: readInt(env.WAR_INPUT_MAX_DURATION_MS, 5000, 0, 60000, 'WAR_INPUT_MAX_DURATION_MS'),
    inputMaxScrollDelta: readInt(env.WAR_INPUT_MAX_SCROLL_DELTA, 5000, 1, 50000, 'WAR_INPUT_MAX_SCROLL_DELTA'),
    semanticDefaultTimeoutMs: readInt(env.WAR_SEMANTIC_DEFAULT_TIMEOUT_MS, 5000, 100, 60000, 'WAR_SEMANTIC_DEFAULT_TIMEOUT_MS'),
    semanticMaxTimeoutMs: readInt(env.WAR_SEMANTIC_MAX_TIMEOUT_MS, 30000, 100, 120000, 'WAR_SEMANTIC_MAX_TIMEOUT_MS'),
    screenshotMaxBytes: readInt(env.WAR_SCREENSHOT_MAX_BYTES, 5 * 1024 * 1024, 1024, 50 * 1024 * 1024, 'WAR_SCREENSHOT_MAX_BYTES'),
    nodeEnv: readString(env.NODE_ENV, 'development')
  };
  if (config.semanticDefaultTimeoutMs > config.semanticMaxTimeoutMs) {
    throw new AgentError('invalid_config', 'WAR_SEMANTIC_DEFAULT_TIMEOUT_MS must be <= WAR_SEMANTIC_MAX_TIMEOUT_MS');
  }
  config.paths = {
    deviceDir: path.join(config.dataDir, 'device'),
    profileDir: path.join(config.dataDir, 'chromium-profile'),
    downloadsDir: path.join(config.dataDir, 'downloads'),
    logsDir: path.join(config.dataDir, 'logs')
  };
  validateBind(config);
  return config;
}

export function serializeConfig(config) {
  return redact({
    ...config,
    token: config.token ? '[REDACTED]' : undefined
  });
}

export function ensureDataDirs(config) {
  for (const dir of Object.values(config.paths)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function validateBind(config) {
  if (isLoopbackHost(config.host)) return;
  if (!config.allowRemote) {
    throw new AgentError('invalid_config', 'Non-loopback bind requires WAR_AGENT_ALLOW_REMOTE=1');
  }
  if (!config.token || config.token.length < 24) {
    throw new AgentError('invalid_config', 'Remote bind requires WAR_AGENT_TOKEN with at least 24 characters');
  }
  if (!Array.isArray(config.allow) || config.allow.length === 0) {
    throw new AgentError('invalid_config', 'Remote bind requires WAR_AGENT_ALLOW with at least one explicit IP');
  }
}

export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function readString(value, fallback) {
  return value === undefined || value === '' ? fallback : String(value);
}

function readOptionalString(value) {
  return value === undefined || value === '' ? undefined : String(value);
}

function readList(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function readBool(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new AgentError('invalid_config', `${name} must be true/false or 1/0`);
}

function readInt(value, fallback, min, max, name) {
  const raw = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(raw) || raw < min || raw > max) {
    throw new AgentError('invalid_config', `${name} must be an integer between ${min} and ${max}`);
  }
  return raw;
}

function resolvePath(value, cwd) {
  return path.resolve(cwd, value);
}
