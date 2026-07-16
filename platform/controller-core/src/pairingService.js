import crypto from 'node:crypto';
import { requireDevice, rejectRevoked } from './deviceRegistry.js';
import { domainError, ERROR_CODES } from './errors.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING = 32;
const CODE_BYTES = 18;
const CREDENTIAL_BYTES = 32;

export class PairingService {
  constructor({ store, audit, now, randomBytes = crypto.randomBytes, ttlMs = DEFAULT_TTL_MS, maxPending = DEFAULT_MAX_PENDING }) {
    this.store = store;
    this.audit = audit;
    this.now = now;
    this.randomBytes = randomBytes;
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
  }

  requestPairing({ device, displayName, requestId }) {
    const requestedAt = this.now();
    const expiresAt = new Date(Date.parse(requestedAt) + this.ttlMs).toISOString();
    const code = base64url(this.randomBytes(CODE_BYTES));
    const tokenHash = hashSecret(code);
    return this.store.update((state) => {
      cleanupExpiredPairings(state, requestedAt);
      state.pendingPairings ||= [];
      if (state.pendingPairings.length >= this.maxPending) throw domainError(ERROR_CODES.CAPACITY_EXCEEDED, 'Pending pairing limit exceeded', 413);
      const id = requestId || `pair-${base64url(this.randomBytes(12))}`;
      if (state.pendingPairings.some((item) => item.requestId === id)) throw domainError(ERROR_CODES.DUPLICATE_JOB, 'Pairing request already exists', 409);
      state.pendingPairings.push({
        requestId: id,
        device: sanitizeDevice(device),
        displayName: String(displayName || device?.displayName || 'Endpoint'),
        tokenHash,
        requestedAt,
        expiresAt,
        status: 'pending',
        consumedAt: null
      });
      this.audit.append(state, 'pairing.requested', { requestId: id, deviceId: device?.deviceId, expiresAt });
      return { requestId: id, code, expiresAt };
    });
  }

  confirmPairing(requestId, code) {
    const decidedAt = this.now();
    const credential = base64url(this.randomBytes(CREDENTIAL_BYTES));
    const credentialHash = hashSecret(credential);
    return this.store.update((state) => {
      const request = requirePendingPairing(state, requestId);
      if (request.consumedAt || request.status !== 'pending') throw domainError(ERROR_CODES.AUTH_DENIED, 'Pairing request was already used', 409);
      if (Date.parse(request.expiresAt) <= Date.parse(decidedAt)) {
        request.status = 'expired';
        throw domainError(ERROR_CODES.JOB_EXPIRED, 'Pairing request expired', 410);
      }
      if (!timingSafeDigestEqual(request.tokenHash, hashSecret(code))) throw domainError(ERROR_CODES.AUTH_DENIED, 'Pairing token rejected', 401);
      request.status = 'accepted';
      request.consumedAt = decidedAt;
      state.pairedAgents ||= [];
      state.pairedAgents = state.pairedAgents.filter((item) => item.deviceId !== request.device.deviceId);
      state.pairedAgents.push({
        deviceId: request.device.deviceId,
        credentialHash,
        pairedAt: decidedAt,
        revokedAt: null
      });
      upsertDeviceFromPairing(state, request.device, decidedAt);
      this.audit.append(state, 'pairing.accepted', { requestId, deviceId: request.device.deviceId });
      return { requestId, accepted: true, deviceId: request.device.deviceId, credential, decidedAt };
    });
  }

  rejectPairing(requestId, reason = 'rejected') {
    const decidedAt = this.now();
    return this.store.update((state) => {
      cleanupExpiredPairings(state, decidedAt);
      const request = requirePendingPairing(state, requestId);
      if (request.consumedAt || request.status !== 'pending') throw domainError(ERROR_CODES.AUTH_DENIED, 'Pairing request was already used', 409);
      request.status = 'rejected';
      request.consumedAt = decidedAt;
      this.audit.append(state, 'pairing.rejected', { requestId, deviceId: request.device.deviceId, reason });
      return { requestId, accepted: false, decidedAt };
    });
  }

  revoke(deviceId) {
    const revokedAt = this.now();
    return this.store.update((state) => {
      const record = (state.pairedAgents || []).find((item) => item.deviceId === deviceId && !item.revokedAt);
      if (!record) throw domainError(ERROR_CODES.DEVICE_NOT_FOUND, 'Paired device not found', 404);
      record.revokedAt = revokedAt;
      const device = state.devices.find((item) => item.id === deviceId);
      if (device) {
        device.revoked = true;
        device.status = 'offline';
        device.revokedAt = revokedAt;
      }
      this.audit.append(state, 'pairing.revoked', { deviceId });
      return { ok: true, deviceId, revokedAt };
    });
  }

  verifyCredential(deviceId, credential) {
    const state = this.store.snapshot();
    const record = (state.pairedAgents || []).find((item) => item.deviceId === deviceId && !item.revokedAt);
    if (!record || !timingSafeDigestEqual(record.credentialHash, hashSecret(credential))) throw domainError(ERROR_CODES.AUTH_DENIED, 'Agent session credential rejected', 401);
    const device = requireDevice(state, deviceId);
    rejectRevoked(device);
    return true;
  }

  cleanupExpired() {
    const at = this.now();
    return this.store.update((state) => cleanupExpiredPairings(state, at, { removeExpired: true }));
  }
}

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function timingSafeDigestEqual(storedDigest, candidateDigest) {
  if (typeof storedDigest !== 'string' || typeof candidateDigest !== 'string') return false;
  if (!/^[a-f0-9]+$/i.test(storedDigest) || !/^[a-f0-9]+$/i.test(candidateDigest)) return false;
  const stored = Buffer.from(storedDigest, 'hex');
  const candidate = Buffer.from(candidateDigest, 'hex');
  if (stored.length !== candidate.length || stored.length === 0) return false;
  return crypto.timingSafeEqual(stored, candidate);
}

export function cleanupExpiredPairings(state, nowIso, { removeExpired = false } = {}) {
  state.pendingPairings ||= [];
  const nowMs = Date.parse(nowIso);
  for (const item of state.pendingPairings) {
    if (item.status === 'pending' && Date.parse(item.expiresAt) <= nowMs) item.status = 'expired';
  }
  if (removeExpired) state.pendingPairings = state.pendingPairings.filter((item) => item.status !== 'expired');
  return { pending: state.pendingPairings.filter((item) => item.status === 'pending').length };
}

function requirePendingPairing(state, requestId) {
  const request = (state.pendingPairings || []).find((item) => item.requestId === requestId);
  if (!request) throw domainError(ERROR_CODES.DEVICE_NOT_FOUND, 'Pairing request not found', 404);
  return request;
}

function upsertDeviceFromPairing(state, device, now) {
  const existing = state.devices.find((item) => item.id === device.deviceId);
  const item = {
    id: device.deviceId,
    name: device.displayName,
    groupIds: device.groupIds || [],
    labels: device.labels || [],
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    status: 'online',
    extensionVersion: device.extensionVersion || '',
    browser: device.browserVersion || '',
    capabilities: device.capabilities || {},
    profiles: existing?.profiles || []
  };
  if (existing) Object.assign(existing, item, { revoked: false, revokedAt: null });
  else state.devices.push(item);
}

function sanitizeDevice(device = {}) {
  return {
    deviceId: String(device.deviceId || ''),
    displayName: String(device.displayName || device.deviceId || 'Endpoint'),
    hostName: String(device.hostName || ''),
    platform: String(device.platform || ''),
    architecture: String(device.architecture || ''),
    agentVersion: String(device.agentVersion || ''),
    extensionVersion: String(device.extensionVersion || ''),
    browserVersion: String(device.browserVersion || ''),
    protocolVersion: String(device.protocolVersion || ''),
    capabilities: device.capabilities || {},
    labels: Array.isArray(device.labels) ? [...device.labels] : [],
    groupIds: Array.isArray(device.groupIds) ? [...device.groupIds] : []
  };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}
