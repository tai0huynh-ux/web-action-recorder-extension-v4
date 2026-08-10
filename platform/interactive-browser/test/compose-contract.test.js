import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const composeUrl = new URL('../compose.yml', import.meta.url);
const sunshineUrl = new URL('../sunshine.conf', import.meta.url);

function serviceBlock(compose, name) {
  const match = compose.match(new RegExp(`^  ${name}:\\s*\\n[\\s\\S]*?(?=^  [a-z][\\w-]*:|^volumes:|^networks:|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing ${name} service`);
  return match[0];
}

function networkBlock(compose, name) {
  const match = compose.match(new RegExp(`^  ${name}:\\s*\\n[\\s\\S]*?(?=^  [\\w-]+:|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `missing ${name} network`);
  return match[0];
}

test('splits Chrome macvlan egress from non-internal Sunshine bridge ingress and port publishing', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const chrome = serviceBlock(compose, 'interactive-chrome-pilot');
  const sunshine = serviceBlock(compose, 'interactive-sunshine-pilot');

  assert.match(chrome, /WAR_PILOT_ROLE: chrome/);
  assert.match(chrome, /networks:\s*\n\s*- pilot-external/);
  assert.doesNotMatch(chrome, /pilot-ingress|ports:/);
  assert.match(sunshine, /WAR_PILOT_ROLE: sunshine/);
  assert.match(sunshine, /networks:\s*\n\s*- pilot-ingress/);
  assert.doesNotMatch(sunshine, /pilot-external/);
  for (const port of ['47984', '47989', '47990', '48010']) {
    assert.match(sunshine, new RegExp(`\\$\\{WAR_PILOT_BIND_ADDRESS[^}]*\\}:${port}:${port}/tcp`));
  }
  assert.match(sunshine, /\$\{WAR_PILOT_BIND_ADDRESS[^}]*\}:47998-48000:47998-48000\/udp/);
  const ingress = networkBlock(compose, 'pilot-ingress');
  assert.doesNotMatch(ingress, /\binternal:\s*true/);
  assert.match(compose, /pilot-external:\s*\n\s+name: .*\n\s+external: true/);
});

test('disables bridge masquerading on Sunshine ingress without marking it internal', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const ingress = networkBlock(compose, 'pilot-ingress');
  assert.match(ingress, /driver: bridge\s*\n\s+driver_opts:\s*\n\s+com\.docker\.network\.bridge\.enable_ip_masquerade:\s*"false"/);
});

test('shares X11 only and persists Chrome and Sunshine state in separate volumes', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const chrome = serviceBlock(compose, 'interactive-chrome-pilot');
  const sunshine = serviceBlock(compose, 'interactive-sunshine-pilot');
  assert.match(chrome, /pilot-chrome-profile:\/data\/chrome-profile/);
  assert.doesNotMatch(chrome, /pilot-sunshine-state/);
  assert.match(sunshine, /pilot-sunshine-state:\/home\/warpilot\/\.config\/sunshine/);
  assert.doesNotMatch(sunshine, /pilot-chrome-profile/);
  for (const service of [chrome, sunshine]) {
    assert.match(service, /pilot-x11-socket:\/tmp\/\.X11-unix/);
  }
});

test('keeps Sunshine off the public IPv6 interface', async () => {
  const config = await readFile(sunshineUrl, 'utf8');
  assert.match(config, /^address_family\s*=\s*ipv4$/m);
  assert.doesNotMatch(config, /^address_family\s*=\s*both$/m);
  assert.match(config, /^upnp\s*=\s*disabled$/m);
});
