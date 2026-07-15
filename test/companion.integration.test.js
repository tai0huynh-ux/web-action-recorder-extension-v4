import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../companion/server.js';
import { createMemoryStore } from '../companion/store.js';

const admin = 'a'.repeat(32);
const enroll = 'e'.repeat(32);

test('companion enrolls two devices and leases only matching queue', async (t) => {
  const store = createMemoryStore();
  await store.load();
  const server = createServer({ allow: ['127.0.0.1', '::1'], adminToken: admin, enrollmentToken: enroll, leaseMs: 10000 }, store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const a = await post(`${base}/v1/devices/enroll`, enroll, { name: 'A' });
  const b = await post(`${base}/v1/devices/enroll`, enroll, { name: 'B' });
  const batch = await post(`${base}/v1/batches`, admin, { deviceIds: [a.id, b.id], profileId: 'profile-1', dataset: [{ text: 'same' }] });
  assert.equal(batch.commands.length, 2);

  const nextA = await get(`${base}/v1/devices/${a.id}/commands/next`, a.deviceToken);
  const nextB = await get(`${base}/v1/devices/${b.id}/commands/next`, b.deviceToken);
  assert.equal(nextA.deviceId, a.id);
  assert.equal(nextB.deviceId, b.id);
});

async function post(url, token, body) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}

async function get(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) assert.fail(await response.text());
  return response.json();
}
