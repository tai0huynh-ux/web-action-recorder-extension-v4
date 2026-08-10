import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHostBindAddress, assertSunshineAddressFamily, isLanIpv4Address } from '../network-policy.mjs';

test('accepts RFC1918 LAN addresses only', () => {
  for (const address of ['10.20.30.40', '172.16.1.1', '172.31.255.254', '192.168.1.201']) {
    assert.equal(isLanIpv4Address(address), true);
  }
  for (const address of ['0.0.0.0', '127.0.0.1', '169.254.1.1', '8.8.8.8', '2001:db8::1', '999.1.1.1']) {
    assert.equal(isLanIpv4Address(address), false, address);
  }
});

test('requires explicit private IPv4 host publishing and IPv4-only Sunshine on the private ingress bridge', () => {
  assert.equal(assertHostBindAddress('192.168.1.201'), '192.168.1.201');
  assert.throws(() => assertHostBindAddress('::'), /private LAN/);
  assert.equal(assertSunshineAddressFamily('ipv4'), 'ipv4');
  assert.equal(assertSunshineAddressFamily('ipv4', { privateIpv4Ingress: true }), 'ipv4');
  assert.throws(() => assertSunshineAddressFamily('both', { privateIpv4Ingress: true }), /must be "ipv4"/);
  assert.throws(() => assertSunshineAddressFamily('ipv6'), /Sunshine 0\.23/);
});
