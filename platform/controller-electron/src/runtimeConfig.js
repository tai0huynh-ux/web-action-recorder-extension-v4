import nodeFs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_PORT = 0;

export function resolveElectronRuntimeConfig({
  app,
  env = process.env,
  fs = nodeFs,
  path = nodePath,
} = {}) {
  const userData = app?.getPath ? app.getPath('userData') : path.join(os.homedir(), '.war-controller');
  const dataPath = env.WAR_CONTROLLER_ELECTRON_DATA_PATH || userData;
  const host = env.WAR_CONTROLLER_WSS_HOST || '127.0.0.1';
  const port = parsePort(env.WAR_CONTROLLER_WSS_PORT);
  const certPath = env.WAR_CONTROLLER_TLS_CERT_PATH;
  const keyPath = env.WAR_CONTROLLER_TLS_KEY_PATH;
  const containerRuntime = env.WAR_CONTAINER_RUNTIME || 'disabled';
  const containerSshTarget = env.WAR_CONTAINER_SSH_TARGET || '';
  const containerControllerHost = env.WAR_CONTAINER_CONTROLLER_HOST || '';
  const containerControllerCaPath = env.WAR_CONTAINER_CONTROLLER_CA_PATH || '';
  const containerImage = env.WAR_CONTAINER_IMAGE || 'war-browser-agent:phase1';
  const wssRequested = env.WAR_CONTROLLER_WSS_ENABLED === '1' || Boolean(certPath || keyPath);
  const errors = [];

  if (!LOOPBACK_HOSTS.has(host) && env.WAR_CONTROLLER_ALLOW_LAN !== '1') {
    errors.push('WSS LAN binding requires WAR_CONTROLLER_ALLOW_LAN=1');
  }
  if (port === null) errors.push('WSS port must be an integer from 1 to 65535');
  if (wssRequested) {
    if (!certPath) errors.push('WSS TLS certificate is required');
    if (!keyPath) errors.push('WSS TLS private key is required');
    if (certPath && !isReadable(fs, certPath)) errors.push('WSS TLS certificate is not readable');
    if (keyPath && !isReadable(fs, keyPath)) errors.push('WSS TLS private key is not readable');
  }
  if (!['disabled', 'local-docker', 'ssh-docker'].includes(containerRuntime)) errors.push('Container runtime must be disabled, local-docker, or ssh-docker');
  if (containerRuntime === 'ssh-docker' && !containerSshTarget) errors.push('SSH Docker runtime requires WAR_CONTAINER_SSH_TARGET');
  if (containerRuntime !== 'disabled' && !wssRequested) errors.push('Managed containers require WSS Controller configuration');
  if (containerRuntime === 'local-docker' && containerControllerCaPath && !isReadable(fs, containerControllerCaPath)) errors.push('Container Controller CA file is not readable');

  const wssEnabled = wssRequested && errors.length === 0;
  const containersEnabled = containerRuntime !== 'disabled' && errors.length === 0;
  return deepFreeze({
    dataPath,
    storePath: path.join(dataPath, 'controller-state.json'),
    settingsPath: path.join(dataPath, 'controller-settings.json'),
    devTools: env.WAR_CONTROLLER_ELECTRON_DEVTOOLS === '1',
    degraded: errors.length > 0,
    errors,
    wss: {
      enabled: wssEnabled,
      requested: wssRequested,
      status: wssEnabled ? 'enabled' : (errors.length > 0 ? 'degraded' : 'disabled'),
      host,
      port: port ?? DEFAULT_PORT,
      tls: {
        certPath: certPath || null,
        keyPath: keyPath || null,
      },
    },
    containers: {
      enabled: containersEnabled,
      runtime: containerRuntime,
      sshTarget: containerSshTarget || null,
      controllerHost: containerControllerHost || null,
      controllerCaPath: containerControllerCaPath || null,
      image: containerImage,
      timeoutMs: 120000,
      hostLabel: containerRuntime === 'ssh-docker' ? 'ssh-docker' : 'local-docker',
    },
  });
}

export function toPublicRuntimeConfig(config) {
  return deepFreeze({
    dataPath: config.dataPath ? nodePath.basename(config.dataPath) : null,
    storeStatus: config.degraded ? 'degraded' : 'loaded',
    devTools: Boolean(config.devTools),
    degraded: Boolean(config.degraded),
    errors: [...(config.errors || [])],
    wss: {
      enabled: Boolean(config.wss?.enabled),
      requested: Boolean(config.wss?.requested),
      status: config.wss?.status || 'disabled',
      host: config.wss?.host || '127.0.0.1',
      port: config.wss?.port ?? DEFAULT_PORT,
      tlsConfigured: Boolean(config.wss?.tls?.certPath && config.wss?.tls?.keyPath),
      certificate: config.wss?.tls?.certPath ? nodePath.basename(config.wss.tls.certPath) : null,
    },
    containers: {
      enabled: Boolean(config.containers?.enabled),
      runtime: config.containers?.runtime || 'disabled',
      host: config.containers?.hostLabel || null,
      sshConfigured: Boolean(config.containers?.sshTarget),
      controllerCa: config.containers?.controllerCaPath ? nodePath.basename(config.containers.controllerCaPath) : null,
    },
  });
}

export function resolveRuntimeConfig(env = process.env, appDataPath = nodePath.join(os.homedir(), '.war-controller')) {
  return resolveElectronRuntimeConfig({
    app: { getPath: () => appDataPath },
    env,
  });
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function isReadable(fs, filePath) {
  try {
    fs.accessSync(filePath, fs.constants?.R_OK ?? 4);
    return true;
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
