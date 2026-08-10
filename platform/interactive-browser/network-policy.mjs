const PRIVATE_RANGES = Object.freeze([
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
]);

function parseIpv4(value) {
  const text = String(value ?? '').trim();
  const octets = text.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const numbers = octets.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return numbers;
}

export function ipv4ToInteger(value) {
  const octets = parseIpv4(value);
  if (!octets) return null;
  return (((octets[0] << 24) >>> 0) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

export function isLanIpv4Address(value) {
  const integer = ipv4ToInteger(value);
  return integer !== null && PRIVATE_RANGES.some(([first, last]) => integer >= first && integer <= last);
}

export function assertLanIpv4Address(value, name = 'sunshineAddress') {
  if (!isLanIpv4Address(value)) {
    throw new Error(`${name} must be a specific private LAN IPv4 address (RFC1918); wildcard, loopback, public IPv4, and IPv6 are rejected`);
  }
  return String(value).trim();
}

export function assertHostBindAddress(value, name = 'hostBindAddress') {
  return assertLanIpv4Address(value, name);
}

export function assertSunshineAddressFamily(value, { containerIpv6Only = false, name = 'sunshineAddressFamily' } = {}) {
  const family = String(value ?? '').trim().toLowerCase();
  if (family !== 'ipv4' && family !== 'both') {
    throw new Error(`${name} must be "ipv4" or "both" for Sunshine 0.23.x`);
  }
  if (containerIpv6Only && family !== 'both') {
    throw new Error(`${name} must be "both" when the container has no IPv4 network`);
  }
  return family;
}
