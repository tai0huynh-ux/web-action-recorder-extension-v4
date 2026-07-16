import path from 'node:path';
import os from 'node:os';

export function resolveRuntimeConfig(env = process.env, appDataPath = path.join(os.homedir(), '.war-controller')) {
  const dataPath = env.WAR_CONTROLLER_DATA_PATH || appDataPath;
  const host = env.WAR_CONTROLLER_WSS_HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && env.WAR_CONTROLLER_ALLOW_LAN !== '1') {
    throw new Error('LAN binding requires WAR_CONTROLLER_ALLOW_LAN=1');
  }
  return Object.freeze({
    dataPath,
    storePath: path.join(dataPath, 'controller-state.json'),
    wss: Object.freeze({ enabled: Boolean(env.WAR_CONTROLLER_TLS_CERT && env.WAR_CONTROLLER_TLS_KEY), host, port: Number(env.WAR_CONTROLLER_WSS_PORT || 0) })
  });
}
