import crypto from 'node:crypto';

export const COMMAND_TYPES = new Set(['run_profile', 'stop_run', 'get_state']);

export function buildAssignments({ devices, profileId, type = 'run_profile', inputs = {}, dataset = [], assignmentMode = 'same', allowDuplicate = true, seed = 'war' }) {
  const records = normalizeRecords(dataset, inputs);
  if (assignmentMode === 'random_pool' && !allowDuplicate && records.length < devices.length) {
    throw new Error('Not enough dataset records for non-duplicate assignment');
  }
  const shuffled = seededShuffle(records, seed);
  return devices.map((device, index) => {
    const record = pickRecord({ records, shuffled, device, index, assignmentMode, allowDuplicate });
    return {
      id: crypto.randomUUID(),
      deviceId: device.id,
      type,
      profileId,
      inputs: record,
      status: 'queued',
      attempt: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      notBefore: new Date().toISOString()
    };
  });
}

export function leaseNextCommand(state, deviceId, leaseMs = 30000) {
  const now = Date.now();
  requeueExpired(state, now);
  const command = state.commands.find((item) => item.deviceId === deviceId && item.status === 'queued' && Date.parse(item.notBefore || 0) <= now);
  if (!command) return null;
  command.status = 'leased';
  command.attempt = Number(command.attempt || 0) + 1;
  command.leaseId = crypto.randomUUID();
  command.leaseUntil = new Date(now + leaseMs).toISOString();
  command.startedAt ||= new Date(now).toISOString();
  return structuredClone(command);
}

export function ackCommand(state, deviceId, commandId, leaseId) {
  const command = state.commands.find((item) => item.id === commandId && item.deviceId === deviceId);
  if (!command) throw new Error('Command not found');
  if (command.leaseId !== leaseId) throw new Error('Lease mismatch');
  command.status = 'running';
  return structuredClone(command);
}

export function finishCommand(state, deviceId, commandId, leaseId, result) {
  const command = state.commands.find((item) => item.id === commandId && item.deviceId === deviceId);
  if (!command) throw new Error('Command not found');
  if (command.leaseId !== leaseId) throw new Error('Lease mismatch');
  if (['succeeded', 'failed', 'cancelled'].includes(command.status)) return structuredClone(command);
  command.status = result?.ok === false ? 'failed' : 'succeeded';
  command.result = result;
  command.completedAt = new Date().toISOString();
  state.results.push({ commandId, deviceId, result, completedAt: command.completedAt });
  return structuredClone(command);
}

export function requeueExpired(state, now = Date.now()) {
  for (const command of state.commands) {
    if (command.status !== 'leased' && command.status !== 'running') continue;
    if (!command.leaseUntil || Date.parse(command.leaseUntil) > now) continue;
    if (Number(command.attempt || 0) >= Number(command.maxAttempts || 3)) {
      command.status = 'failed';
      command.error = 'Lease expired';
      command.completedAt = new Date(now).toISOString();
    } else {
      command.status = 'queued';
      command.leaseId = null;
      command.leaseUntil = null;
      command.notBefore = new Date(now + 1000).toISOString();
    }
  }
}

function normalizeRecords(dataset, inputs) {
  if (Array.isArray(dataset) && dataset.length) return dataset;
  if (inputs && typeof inputs === 'object') return [inputs];
  return [{}];
}

function pickRecord({ records, shuffled, device, index, assignmentMode, allowDuplicate }) {
  if (assignmentMode === 'per_device') return records.find((record) => record.deviceId === device.id || record.deviceName === device.name) || {};
  if (assignmentMode === 'mapping') return records.find((record) => record.deviceKey === device.id || record.deviceKey === device.name) || {};
  if (assignmentMode === 'random_pool') return allowDuplicate ? shuffled[index % shuffled.length] : shuffled[index];
  return records[0] || {};
}

function seededShuffle(records, seed) {
  const next = records.map((record) => ({ ...record }));
  let state = hashSeed(seed);
  for (let i = next.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function hashSeed(seed) {
  return [...String(seed)].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
}
