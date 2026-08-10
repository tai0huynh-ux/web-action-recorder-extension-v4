import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireProfileLease, readProfileLease, releaseProfileLease } from '../profile-lease.mjs';

async function tempProfile() {
  return mkdtemp(path.join(os.tmpdir(), 'war-interactive-lease-'));
}

test('acquires exclusive token/generation and safely releases matching lease', async () => {
  const profile = await tempProfile();
  const first = await acquireProfileLease(profile, { identityId: 'id-a', mode: 'interactive' });
  assert.equal(first.generation, 1);
  assert.equal((await readProfileLease(profile)).token, first.token);
  await assert.rejects(() => acquireProfileLease(profile), (error) => error.code === 'PROFILE_LEASE_HELD');
  assert.equal(await releaseProfileLease(first), true);
  const second = await acquireProfileLease(profile);
  assert.equal(second.generation, 2);
  await assert.rejects(() => releaseProfileLease({ ...second, token: 'wrong' }), (error) => error.code === 'PROFILE_LEASE_MISMATCH');
  assert.equal(await releaseProfileLease(second), true);
});

test('fails closed on stale lease and never deletes it', async () => {
  const profile = await tempProfile();
  const leasePath = path.join(profile, '.war-profile-lease.json');
  await writeFile(leasePath, JSON.stringify({ token: 'old', generation: 7, expiresAt: '2000-01-01T00:00:00.000Z' }));
  await assert.rejects(() => acquireProfileLease(profile), (error) => error.code === 'PROFILE_LEASE_STALE');
  assert.match(await readFile(leasePath, 'utf8'), /"old"/);
});
