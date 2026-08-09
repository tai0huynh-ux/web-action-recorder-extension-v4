import nodeFs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import { normalizeIpv6Prefix } from '../../controller-core/src/networkConfig.js';
import { normalizeControllerHost } from './controllerHost.js';
import { isImmutableImagePin, validateRuntimeProfile } from './runtimeProfileStore.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_PORT = 0;
export const MANAGED_CONTAINER_HOST_ID = 'configured-docker-host';

export function resolveElectronRuntimeConfig({
  app,
  env = process.env,
  fs = nodeFs,
  path = nodePath,
  runtimeProfile = null,
  runtimeProfileStatus = 'missing',
} = {}) {
  const userData = app?.getPath ? app.getPath('userData') : path.join(os.homedir(), '.war-controller');
  const dataPath = env.WAR_CONTROLLER_ELECTRON_DATA_PATH || userData;
  const explicitWssEnvironment = hasWssEnvironment(env);
  const validatedProfile = runtimeProfile === null ? null : validateRuntimeProfile(runtimeProfile);
  const storedProfile = validatedProfile?.ok ? validatedProfile.profile : null;
  const profileWss = !explicitWssEnvironment ? storedProfile?.wss : null;
  const host = explicitWssEnvironment ? (env.WAR_CONTROLLER_WSS_HOST || '127.0.0.1') : (profileWss?.host || '127.0.0.1');
  const port = explicitWssEnvironment ? parsePort(env.WAR_CONTROLLER_WSS_PORT) : (profileWss?.port ?? DEFAULT_PORT);
  const certPath = explicitWssEnvironment ? env.WAR_CONTROLLER_TLS_CERT_PATH : profileWss?.certificatePath;
  const keyPath = explicitWssEnvironment ? env.WAR_CONTROLLER_TLS_KEY_PATH : profileWss?.privateKeyPath;
  const containerRuntime = env.WAR_CONTAINER_RUNTIME || 'disabled';
  const containerHostLabel = env.WAR_CONTAINER_HOST_LABEL || '';
  const containerSshTarget = env.WAR_CONTAINER_SSH_TARGET || '';
  const containerSshIdentityFile = env.WAR_CONTAINER_SSH_IDENTITY_FILE || '';
  const containerControllerHost = env.WAR_CONTAINER_CONTROLLER_HOST || '';
  const normalizedContainerControllerHost = normalizeControllerHost(containerControllerHost);
  const containerControllerCaPath = env.WAR_CONTAINER_CONTROLLER_CA_PATH || '';
  const containerSeccompProfilePath = env.WAR_CONTAINER_SECCOMP_PROFILE_PATH || '';
  const explicitContainerImage = Object.hasOwn(env, 'WAR_CONTAINER_IMAGE') ? env.WAR_CONTAINER_IMAGE : null;
  const containerImagePin = explicitContainerImage ?? storedProfile?.imagePin ?? null;
  const containerIpv6Interface = env.WAR_CONTAINER_IPV6_INTERFACE || '';
  const containerIpv6Prefix = env.WAR_CONTAINER_IPV6_PREFIX || '';
  const containerIpv6Driver = env.WAR_CONTAINER_IPV6_DRIVER || 'macvlan';
  const wssRequested = explicitWssEnvironment
    ? env.WAR_CONTROLLER_WSS_ENABLED === '1' || Boolean(certPath || keyPath)
    : profileWss?.enabled === true;
  const errors = [];

  const lanBindingApproved = explicitWssEnvironment ? env.WAR_CONTROLLER_ALLOW_LAN === '1' : profileWss?.lanBindingApproved === true;
  if (!LOOPBACK_HOSTS.has(host) && !lanBindingApproved) {
    errors.push('WSS LAN binding requires WAR_CONTROLLER_ALLOW_LAN=1');
  }
  if (port === null) errors.push('WSS port must be an integer from 1 to 65535');
  if (!explicitWssEnvironment && runtimeProfileStatus === 'invalid') errors.push('Stored runtime profile is invalid');
  if (!explicitWssEnvironment && runtimeProfile !== null && !storedProfile) errors.push('Stored runtime profile is invalid');
  if (wssRequested) {
    if (!certPath) errors.push('WSS TLS certificate is required');
    if (!keyPath) errors.push('WSS TLS private key is required');
    if (certPath && !isReadable(fs, certPath)) errors.push('WSS TLS certificate is not readable');
    if (keyPath && !isReadable(fs, keyPath)) errors.push('WSS TLS private key is not readable');
  }
  if (!['disabled', 'local-docker', 'ssh-docker'].includes(containerRuntime)) errors.push('Container runtime must be disabled, local-docker, or ssh-docker');
  if (containerRuntime !== 'disabled' && !isImmutableImagePin(containerImagePin)) errors.push('Managed containers require an immutable image pin');
  if (containerHostLabel && !isHostLabel(containerHostLabel)) errors.push('Container host label is invalid');
  if (containerControllerHost && !normalizedContainerControllerHost) errors.push('Container Controller host is invalid');
  if (containerRuntime === 'ssh-docker' && !containerSshTarget) errors.push('SSH Docker runtime requires WAR_CONTAINER_SSH_TARGET');
  if (containerRuntime === 'ssh-docker' && containerSshTarget && !isSshTarget(containerSshTarget)) errors.push('SSH Docker target is invalid');
  if (containerRuntime === 'ssh-docker' && !containerSshIdentityFile) errors.push('SSH Docker runtime requires WAR_CONTAINER_SSH_IDENTITY_FILE');
  if (containerRuntime === 'ssh-docker' && containerSshIdentityFile && !isReadable(fs, containerSshIdentityFile)) errors.push('SSH Docker identity file is not readable');
  if (containerRuntime !== 'disabled' && !wssRequested) errors.push('Managed containers require WSS Controller configuration');
  if (containerRuntime === 'local-docker' && containerControllerCaPath && !isReadable(fs, containerControllerCaPath)) errors.push('Container Controller CA file is not readable');
  if (containerRuntime !== 'disabled' && !containerSeccompProfilePath) errors.push('Managed containers require WAR_CONTAINER_SECCOMP_PROFILE_PATH');
  if (containerRuntime === 'local-docker' && containerSeccompProfilePath && !isReadable(fs, containerSeccompProfilePath)) errors.push('Container seccomp profile is not readable');
  if (containerRuntime === 'ssh-docker' && containerSeccompProfilePath && !/^\/[A-Za-z0-9._/-]+$/.test(containerSeccompProfilePath)) errors.push('SSH container seccomp profile path must be absolute');
  if (containerIpv6Interface && !/^[A-Za-z0-9_.:-]{1,32}$/.test(containerIpv6Interface)) errors.push('Container IPv6 interface is invalid');
  if (!['bridge', 'macvlan'].includes(containerIpv6Driver)) errors.push('Container IPv6 driver must be bridge or macvlan');
  let normalizedIpv6Prefix = null;
  if (containerIpv6Prefix) {
    try {
      normalizedIpv6Prefix = normalizeIpv6Prefix(containerIpv6Prefix);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const wssEnabled = wssRequested && errors.length === 0;
  const containersEnabled = containerRuntime !== 'disabled' && errors.length === 0;
  return deepFreeze({
    dataPath,
    storePath: path.join(dataPath, 'controller-state.json'),
    settingsPath: path.join(dataPath, 'controller-settings.json'),
    runtimeProfilePath: path.join(dataPath, 'controller-runtime.json'),
    runtimeProfile: storedProfile || (explicitWssEnvironment ? runtimeProfile : null),
    runtimeProfileStatus,
    devTools: env.WAR_CONTROLLER_ELECTRON_DEVTOOLS === '1',
    degraded: errors.length > 0,
    errors,
    wss: {
      enabled: wssEnabled,
      requested: wssRequested,
      status: wssEnabled ? 'enabled' : (errors.length > 0 ? 'degraded' : 'disabled'),
      source: explicitWssEnvironment ? 'environment' : (profileWss ? 'profile' : 'none'),
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
      hostId: containerRuntime === 'disabled' ? null : MANAGED_CONTAINER_HOST_ID,
      hostDisplayName: containerHostLabel || null,
      sshTarget: containerSshTarget || null,
      sshIdentityFile: containerSshIdentityFile || null,
      controllerHost: normalizedContainerControllerHost,
      controllerCaPath: containerControllerCaPath || null,
      seccompProfilePath: containerSeccompProfilePath || null,
      // Keep image as a compatibility alias for internal adapter callers; it is
      // always the validated immutable pin for an enabled managed runtime.
      image: containerImagePin,
      imagePin: isImmutableImagePin(containerImagePin) ? containerImagePin : null,
      ipv6Interface: containerIpv6Interface || null,
      ipv6Prefix: normalizedIpv6Prefix,
      ipv6Driver: containerIpv6Driver,
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
      hostId: config.containers?.enabled ? config.containers?.hostId || MANAGED_CONTAINER_HOST_ID : null,
      hostLabel: config.containers?.hostDisplayName || null,
      sshConfigured: Boolean(config.containers?.sshTarget),
      sshIdentityConfigured: Boolean(config.containers?.sshIdentityFile),
      controllerCa: config.containers?.controllerCaPath ? nodePath.basename(config.containers.controllerCaPath) : null,
      seccompProfile: config.containers?.seccompProfilePath ? nodePath.basename(config.containers.seccompProfilePath) : null,
      ipv6AutoPrefix: !config.containers?.ipv6Prefix,
      ipv6InterfaceConfigured: Boolean(config.containers?.ipv6Interface),
      ipv6StaticPrefixConfigured: Boolean(config.containers?.ipv6Prefix),
      ipv6Driver: config.containers?.ipv6Driver || null,
    },
  });
}

export function resolveRuntimeConfig(env = process.env, appDataPath = nodePath.join(os.homedir(), '.war-controller')) {
  return resolveElectronRuntimeConfig({
    app: { getPath: () => appDataPath },
    env,
  });
}

export function withBoundWssPort(config, port) {
  if (!config?.wss?.enabled || config.wss.port !== DEFAULT_PORT) return config;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WSS runtime did not report a valid bound port');
  }
  return deepFreeze({ ...config, wss: { ...config.wss, port } });
}

export function runtimeProfileFromConfig(config) {
  if (!config?.wss?.enabled || !Number.isInteger(config.wss.port) || config.wss.port < 1 || config.wss.port > 65535) {
    throw new Error('A running WSS endpoint with a stable port is required to persist a runtime profile');
  }
  const profile = {
    schemaVersion: 1,
    wss: {
      enabled: true,
      host: config.wss.host,
      port: config.wss.port,
      lanBindingApproved: !LOOPBACK_HOSTS.has(config.wss.host),
      certificatePath: config.wss.tls?.certPath,
      privateKeyPath: config.wss.tls?.keyPath,
    },
    ...(config.containers?.imagePin ? { imagePin: config.containers.imagePin } : {}),
  };
  const validated = validateRuntimeProfile(profile);
  if (!validated.ok) throw new Error(validated.error);
  return validated.profile;
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function hasWssEnvironment(env) {
  return [
    'WAR_CONTROLLER_WSS_ENABLED',
    'WAR_CONTROLLER_WSS_HOST',
    'WAR_CONTROLLER_WSS_PORT',
    'WAR_CONTROLLER_ALLOW_LAN',
    'WAR_CONTROLLER_TLS_CERT_PATH',
    'WAR_CONTROLLER_TLS_KEY_PATH',
  ].some((key) => Object.hasOwn(env, key));
}

function isReadable(fs, filePath) {
  try {
    fs.accessSync(filePath, fs.constants?.R_OK ?? 4);
    return true;
  } catch {
    return false;
  }
}

function isSshTarget(value) {
  return typeof value === 'string'
    && value.length <= 255
    && /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(value);
}

function isHostLabel(value) {
  return typeof value === 'string'
    && value.trim() === value
    && value.length >= 1
    && value.length <= 80
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
