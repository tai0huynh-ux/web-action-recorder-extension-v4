import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentError } from './errors.js';

export function loadOrCreateDeviceIdentity(deviceDir, now = () => new Date()) {
  fs.mkdirSync(deviceDir, { recursive: true });
  const filePath = path.join(deviceDir, 'identity.json');
  if (fs.existsSync(filePath)) {
    return readIdentity(filePath);
  }
  const identity = {
    schemaVersion: 1,
    deviceId: crypto.randomUUID(),
    createdAt: now().toISOString()
  };
  writeIdentityAtomic(filePath, identity);
  return identity;
}

export function readIdentity(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new AgentError('identity_invalid', `Device identity could not be read: ${error.message}`, 500);
  }
  if (parsed?.schemaVersion !== 1 || typeof parsed.deviceId !== 'string' || !parsed.deviceId || typeof parsed.createdAt !== 'string') {
    throw new AgentError('identity_invalid', 'Device identity file has an invalid schema', 500);
  }
  return parsed;
}

export function writeIdentityAtomic(filePath, identity) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tempPath, filePath);
}
