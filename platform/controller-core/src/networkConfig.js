const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

export function normalizeManagedNetwork(runtime = {}) {
  const ipv4Enabled = runtime.ipv4Enabled !== false;
  const ipv6Enabled = runtime.ipv6Enabled === true;
  if (!ipv4Enabled && !ipv6Enabled) throw new Error('Managed container requires IPv4 or IPv6');
  return {
    ipv4Enabled,
    ipv6Enabled,
    ipv6Suffix: ipv6Enabled ? normalizeIpv6Suffix(runtime.ipv6Suffix) : null,
  };
}

export function normalizeIpv6Suffix(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) throw new Error('IPv6 suffix is required');

  let groups;
  if (text.includes('::') || text.split(':').length > 4) {
    const address = parseIpv6Address(text);
    if (address.slice(0, 4).some((group) => group !== 0)) {
      throw new Error('IPv6 suffix must contain only the final 64 bits');
    }
    groups = address.slice(4);
  } else {
    const parts = text.split(':');
    if (parts.length > 4 || parts.some((part) => !IPV6_GROUP.test(part))) {
      throw new Error('IPv6 suffix must contain one to four hexadecimal groups');
    }
    groups = [...Array(4 - parts.length).fill(0), ...parts.map(parseGroup)];
  }

  if (groups.every((group) => group === 0)) throw new Error('IPv6 suffix cannot be all zeroes');
  if (groups.every((group, index) => index < 3 ? group === 0 : group === 1)) throw new Error('IPv6 suffix ::1 is reserved for the Docker network gateway');
  return groups.map((group) => group.toString(16)).join(':');
}

export function normalizeIpv6Eui64Suffix(value) {
  const suffix = normalizeIpv6Suffix(value);
  const groups = suffix.split(':').map(parseGroup);
  if ((groups[1] & 0xff) !== 0xff || (groups[2] >> 8) !== 0xfe) {
    throw new Error('On-link IPv6 suffix must use EUI-64 form xxxx:xxff:fexx:xxxx');
  }
  return suffix;
}

export function macAddressFromIpv6Eui64Suffix(value) {
  const groups = normalizeIpv6Eui64Suffix(value).split(':').map(parseGroup);
  const bytes = [groups[0] >> 8, groups[0] & 0xff, groups[1] >> 8, groups[2] & 0xff, groups[3] >> 8, groups[3] & 0xff];
  bytes[0] ^= 0x02;
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

export function ipv6Eui64SuffixFromMacAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text)) throw new Error('MAC address is invalid');
  const bytes = text.split(':').map((part) => Number.parseInt(part, 16));
  bytes[0] ^= 0x02;
  return [
    (bytes[0] << 8) | bytes[1],
    (bytes[2] << 8) | 0xff,
    (0xfe << 8) | bytes[3],
    (bytes[4] << 8) | bytes[5],
  ].map((group) => group.toString(16)).join(':');
}

export function normalizeIpv6Prefix(value) {
  const text = String(value || '').trim().toLowerCase();
  const [address, prefixLength, ...extra] = text.split('/');
  if (extra.length || prefixLength !== '64') throw new Error('Managed IPv6 prefix must use /64');
  return ipv6PrefixFromAddress(address, 64);
}

export function ipv6PrefixFromAddress(address, prefixLength) {
  if (Number(prefixLength) !== 64) throw new Error('Managed IPv6 address must use a /64 prefix');
  const groups = parseIpv6Address(address);
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

export function composeIpv6Address(prefix, suffix) {
  const prefixText = normalizeIpv6Prefix(prefix).split('/')[0];
  const prefixGroups = parseIpv6Address(prefixText).slice(0, 4);
  const suffixGroups = normalizeIpv6Suffix(suffix).split(':').map(parseGroup);
  return [...prefixGroups, ...suffixGroups].map((group) => group.toString(16)).join(':');
}

export function normalizeIpv6Address(value) {
  return parseIpv6Address(value).map((group) => group.toString(16)).join(':');
}

function parseIpv6Address(value) {
  const text = String(value || '').trim().toLowerCase().split('%')[0];
  if (!text || text.includes('.') || !/^[0-9a-f:]+$/.test(text)) throw new Error('IPv6 address is invalid');
  const halves = text.split('::');
  if (halves.length > 2) throw new Error('IPv6 address is invalid');
  const head = splitGroups(halves[0]);
  const tail = halves.length === 2 ? splitGroups(halves[1]) : [];
  const omitted = 8 - head.length - tail.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) {
    throw new Error('IPv6 address is invalid');
  }
  return [...head, ...Array(omitted).fill(0), ...tail];
}

function splitGroups(value) {
  if (!value) return [];
  const parts = value.split(':');
  if (parts.some((part) => !IPV6_GROUP.test(part))) throw new Error('IPv6 address is invalid');
  return parts.map(parseGroup);
}

function parseGroup(value) {
  return Number.parseInt(value, 16);
}
