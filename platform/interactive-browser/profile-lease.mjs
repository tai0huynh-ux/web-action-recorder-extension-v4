import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LEASE_FILENAME = '.war-profile-lease.json';
export const GENERATION_FILENAME = '.war-profile-generation';

function leaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseRecord(text, leasePath) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw leaseError('PROFILE_LEASE_INVALID', `profile lease is not valid JSON: ${leasePath}`);
  }
  if (!record || typeof record !== 'object' || typeof record.token !== 'string' || !record.token ||
      !Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw leaseError('PROFILE_LEASE_INVALID', `profile lease has invalid token/generation: ${leasePath}`);
  }
  return record;
}

async function nextGeneration(generationPath) {
  let previous = 0;
  try {
    const text = await readFile(generationPath, 'utf8');
    previous = Number(text.trim());
    if (!Number.isSafeInteger(previous) || previous < 0) {
      throw leaseError('PROFILE_LEASE_INVALID', `profile generation is invalid: ${generationPath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generation = previous + 1;
  await writeFile(generationPath, `${generation}\n`, { encoding: 'utf8', mode: 0o600 });
  return generation;
}

export async function readProfileLease(profileDir, { leasePath = path.join(profileDir, LEASE_FILENAME) } = {}) {
  try {
    return parseRecord(await readFile(leasePath, 'utf8'), leasePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function acquireProfileLease(profileDir, options = {}) {
  if (!profileDir || typeof profileDir !== 'string') throw new TypeError('profileDir is required');
  const leasePath = options.leasePath ?? path.join(profileDir, LEASE_FILENAME);
  const generationPath = options.generationPath ?? path.join(profileDir, GENERATION_FILENAME);
  await mkdir(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  const token = options.token ?? randomUUID();
  if (typeof token !== 'string' || !token) throw new TypeError('lease token is required');
  let handle;
  try {
    handle = await open(leasePath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const existing = await readProfileLease(profileDir, { leasePath });
      if (existing?.expiresAt && Date.parse(existing.expiresAt) <= Date.now()) {
        throw leaseError('PROFILE_LEASE_STALE', 'profile lease is stale; manual fenced recovery is required');
      }
      throw leaseError('PROFILE_LEASE_HELD', 'profile lease already exists; refusing concurrent or stale takeover');
    }
    throw error;
  }
  try {
    const generation = options.generation ?? await nextGeneration(generationPath);
    if (!Number.isSafeInteger(generation) || generation < 1) throw leaseError('PROFILE_LEASE_INVALID', 'lease generation must be a positive integer');
    const record = {
      version: 1,
      token,
      generation,
      identityId: options.identityId ?? null,
      mode: options.mode ?? 'interactive',
      owner: options.owner ?? null,
      pid: process.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    };
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.close();
    return { ...record, leasePath, generationPath };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(leasePath).catch(() => {});
    throw error;
  }
}

export async function releaseProfileLease(lease, options = {}) {
  if (!lease || typeof lease !== 'object' || typeof lease.token !== 'string' || !Number.isSafeInteger(lease.generation)) {
    throw new TypeError('lease handle with token and generation is required');
  }
  const leasePath = options.leasePath ?? lease.leasePath;
  if (!leasePath) throw new TypeError('leasePath is required');
  const current = await readProfileLease(path.dirname(leasePath), { leasePath });
  if (!current) return false;
  if (current.token !== lease.token || current.generation !== lease.generation) {
    throw leaseError('PROFILE_LEASE_MISMATCH', 'profile lease token/generation mismatch; refusing release');
  }
  try {
    await unlink(leasePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
