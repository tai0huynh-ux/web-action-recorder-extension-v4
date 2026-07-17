import fs from 'node:fs';
import path from 'node:path';
import { redactDiagnostic } from '../../diagnostics/src/redaction.js';
import { AgentError } from './errors.js';

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
    nativeBridgeSocketPath: resolvePath(env.WAR_AGENT_SOCKET_PATH || path.join(env.WAR_DATA_DIR || DEFAULTS.dataDir, 'run', 'native-bridge.sock'), cwd),
    nativeBridgeMaxPayloadBytes: readInt(env.WAR_AGENT_SOCKET_MAX_PAYLOAD_BYTES, 1024 * 1024, 1024, 5 * 1024 * 1024, 'WAR_AGENT_SOCKET_MAX_PAYLOAD_BYTES'),
    nativeBridgeIdleTimeoutMs: readInt(env.WAR_AGENT_SOCKET_IDLE_TIMEOUT_MS, 30000, 1000, 300000, 'WAR_AGENT_SOCKET_IDLE_TIMEOUT_MS'),
    nativeBridgeRequestTimeoutMs: readInt(env.WAR_AGENT_SOCKET_REQUEST_TIMEOUT_MS, 10000, 1000, 300000, 'WAR_AGENT_SOCKET_REQUEST_TIMEOUT_MS'),
    nativeBridgeMaxConnections: readInt(env.WAR_AGENT_SOCKET_MAX_CONNECTIONS, 8, 1, 128, 'WAR_AGENT_SOCKET_MAX_CONNECTIONS'),
    controllerWssUrl: readOptionalString(env.WAR_CONTROLLER_WSS_URL),
    controllerSessionCredential: readOptionalString(env.WAR_CONTROLLER_SESSION_CREDENTIAL),
    controllerReconnectMinMs: readInt(env.WAR_CONTROLLER_RECONNECT_MIN_MS, 500, 100, 60000, 'WAR_CONTROLLER_RECONNECT_MIN_MS'),
    controllerReconnectMaxMs: readInt(env.WAR_CONTROLLER_RECONNECT_MAX_MS, 30000, 500, 300000, 'WAR_CONTROLLER_RECONNECT_MAX_MS'),
    controllerMaxPendingRequests: readInt(env.WAR_CONTROLLER_MAX_PENDING_REQUESTS, 128, 1, 5000, 'WAR_CONTROLLER_MAX_PENDING_REQUESTS'),
    controllerMaxOutboundQueue: readInt(env.WAR_CONTROLLER_MAX_OUTBOUND_QUEUE, 256, 1, 10000, 'WAR_CONTROLLER_MAX_OUTBOUND_QUEUE'),
    workflowRegistryMaxCount: readInt(env.WAR_WORKFLOW_REGISTRY_MAX_COUNT, 1000, 1, 100000, 'WAR_WORKFLOW_REGISTRY_MAX_COUNT'),
    workflowRegistryMaxPayloadBytes: readInt(env.WAR_WORKFLOW_REGISTRY_MAX_PAYLOAD_BYTES, 1024 * 1024, 1024, 10 * 1024 * 1024, 'WAR_WORKFLOW_REGISTRY_MAX_PAYLOAD_BYTES'),
    nodeEnv: readString(env.NODE_ENV, 'development')
  };
  if (config.semanticDefaultTimeoutMs > config.semanticMaxTimeoutMs) {
    throw new AgentError('invalid_config', 'WAR_SEMANTIC_DEFAULT_TIMEOUT_MS must be <= WAR_SEMANTIC_MAX_TIMEOUT_MS');
  }
  validateControllerSession(config);
  config.paths = {
    deviceDir: path.join(config.dataDir, 'device'),
    profileDir: path.join(config.dataDir, 'chromium-profile'),
    downloadsDir: path.join(config.dataDir, 'downloads'),
    logsDir: path.join(config.dataDir, 'logs'),
    runtimeDir: path.join(config.dataDir, 'run'),
    workflowDir: path.join(config.dataDir, 'workflows')
  };
  validateBind(config);
  return config;
}

export function serializeConfig(config) {
  return redactDiagnostic({
    ...config,
    token: config.token ? '<redacted>' : undefined,
    controllerSessionCredential: config.controllerSessionCredential ? '<redacted>' : undefined
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

function validateControllerSession(config) {
  if (!config.controllerWssUrl && !config.controllerSessionCredential) return;
  if (!config.controllerWssUrl || !String(config.controllerWssUrl).startsWith('wss://')) {
    throw new AgentError('invalid_config', 'WAR_CONTROLLER_WSS_URL must be a wss:// URL when controller session is enabled');
  }
  if (!config.controllerSessionCredential || config.controllerSessionCredential.length < 24) {
    throw new AgentError('invalid_config', 'WAR_CONTROLLER_SESSION_CREDENTIAL must be at least 24 characters');
  }
  if (config.controllerReconnectMinMs > config.controllerReconnectMaxMs) {
    throw new AgentError('invalid_config', 'WAR_CONTROLLER_RECONNECT_MIN_MS must be <= WAR_CONTROLLER_RECONNECT_MAX_MS');
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
