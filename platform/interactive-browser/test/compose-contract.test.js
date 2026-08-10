import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const composeUrl = new URL('../compose.yml', import.meta.url);
const sunshineUrl = new URL('../sunshine.conf', import.meta.url);

test('uses an internal bridge for Sunshine ingress instead of publishing from macvlan', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  assert.match(compose, /networks:\s*\n\s*- pilot-ingress\s*\n\s*- pilot-external/);
  assert.match(compose, /pilot-ingress:\s*\n\s+driver: bridge\s*\n\s+internal: true/);
  assert.match(compose, /pilot-external:\s*\n\s+name: .*\n\s+external: true/);
  for (const port of ['47984', '47989', '47990', '48010']) {
    assert.match(compose, new RegExp(`:${port}:${port}/tcp`));
  }
  assert.match(compose, /:47998-48000:47998-48000\/udp/);
});

test('keeps Sunshine off the public IPv6 interface', async () => {
  const config = await readFile(sunshineUrl, 'utf8');
  assert.match(config, /^address_family\s*=\s*ipv4$/m);
  assert.doesNotMatch(config, /^address_family\s*=\s*both$/m);
  assert.match(config, /^upnp\s*=\s*disabled$/m);
});
