import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeIpv6Address,
  ipv6PrefixFromAddress,
  normalizeIpv6Address,
  normalizeIpv6Eui64Suffix,
  normalizeIpv6Prefix,
  normalizeIpv6Suffix,
  normalizeManagedNetwork,
  macAddressFromIpv6Eui64Suffix,
  ipv6Eui64SuffixFromMacAddress,
} from '../src/networkConfig.js';

test('managed network defaults to IPv4 and requires at least one address family', () => {
  assert.deepEqual(normalizeManagedNetwork({}), { ipv4Enabled: true, ipv6Enabled: false, ipv6Suffix: null });
  assert.throws(() => normalizeManagedNetwork({ ipv4Enabled: false, ipv6Enabled: false }), /requires IPv4 or IPv6/);
});

test('IPv6 suffix keeps only a normalized final 64-bit identifier', () => {
  assert.equal(normalizeIpv6Suffix('ABCD:0000:12:0001'), 'abcd:0:12:1');
  assert.equal(normalizeIpv6Suffix('::abcd'), '0:0:0:abcd');
  assert.throws(() => normalizeIpv6Suffix('2001:db8::1'), /final 64 bits/);
  assert.throws(() => normalizeIpv6Suffix('::'), /all zeroes/);
  assert.throws(() => normalizeIpv6Suffix('::1'), /Docker network gateway/);
  assert.equal(normalizeIpv6Eui64Suffix('a8bb:ccff:fedd:eeff'), 'a8bb:ccff:fedd:eeff');
  assert.equal(macAddressFromIpv6Eui64Suffix('a8bb:ccff:fedd:eeff'), 'aa:bb:cc:dd:ee:ff');
  assert.equal(ipv6Eui64SuffixFromMacAddress('aa:bb:cc:dd:ee:ff'), 'a8bb:ccff:fedd:eeff');
  assert.throws(() => normalizeIpv6Eui64Suffix('abcd:ef01:2345:6789'), /EUI-64/);
});

test('IPv6 /64 prefix changes do not change the configured suffix', () => {
  const suffix = normalizeIpv6Suffix('abcd:ef01:2345:6789');
  assert.equal(normalizeIpv6Prefix('2001:0db8:1234:5678:ffff::/64'), '2001:db8:1234:5678::/64');
  assert.equal(composeIpv6Address('2001:db8:1234:5678::/64', suffix), '2001:db8:1234:5678:abcd:ef01:2345:6789');
  assert.equal(composeIpv6Address('2001:db8:aaaa:bbbb::/64', suffix), '2001:db8:aaaa:bbbb:abcd:ef01:2345:6789');
  assert.equal(ipv6PrefixFromAddress('2001:db8:aaaa:bbbb::99', 64), '2001:db8:aaaa:bbbb::/64');
  assert.equal(normalizeIpv6Address('2001:0db8::1'), '2001:db8:0:0:0:0:0:1');
});
