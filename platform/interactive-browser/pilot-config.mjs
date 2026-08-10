import { assertHostBindAddress, assertSunshineAddressFamily } from './network-policy.mjs';

const DEFAULTS = Object.freeze({
  chromeBin: '/usr/bin/google-chrome',
  sunshineBin: '/usr/bin/sunshine',
  sunshineConfig: '/etc/sunshine/sunshine.conf',
  profileDir: '/data/chrome-profile',
  sunshineAddressFamily: 'ipv4',
  hostBindAddress: '192.168.1.201',
  privateIpv4Ingress: true,
  browserIpv6OnlyEgress: true,
  width: 1280,
  height: 720,
  fps: 30,
  display: ':99',
});

function positiveInt(value, name, { min = 1, max = 10000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeConfig(input = {}) {
  const value = (key, fallback) => input[key] ?? fallback;
  const display = String(value('display', DEFAULTS.display)).trim();
  if (!/^:[0-9]+$/.test(display)) throw new Error('display must be an X display such as :99');

  const privateIpv4Ingress = value('privateIpv4Ingress', DEFAULTS.privateIpv4Ingress) === true;
  const browserIpv6OnlyEgress = value('browserIpv6OnlyEgress', DEFAULTS.browserIpv6OnlyEgress) === true;
  const addressFamily = assertSunshineAddressFamily(
    value('sunshineAddressFamily', DEFAULTS.sunshineAddressFamily),
    { privateIpv4Ingress },
  );
  const hostBindAddress = String(value('hostBindAddress', DEFAULTS.hostBindAddress)).trim();
  assertHostBindAddress(hostBindAddress);

  const config = {
    chromeBin: String(value('chromeBin', DEFAULTS.chromeBin)).trim(),
    sunshineBin: String(value('sunshineBin', DEFAULTS.sunshineBin)).trim(),
    sunshineConfig: String(value('sunshineConfig', DEFAULTS.sunshineConfig)).trim(),
    profileDir: String(value('profileDir', DEFAULTS.profileDir)).trim(),
    sunshineAddressFamily: addressFamily,
    hostBindAddress,
    privateIpv4Ingress,
    browserIpv6OnlyEgress,
    width: positiveInt(value('width', DEFAULTS.width), 'width', { min: 320, max: 7680 }),
    height: positiveInt(value('height', DEFAULTS.height), 'height', { min: 240, max: 4320 }),
    fps: positiveInt(value('fps', DEFAULTS.fps), 'fps', { min: 1, max: 60 }),
    display,
  };
  for (const [name, path] of Object.entries({ chromeBin: config.chromeBin, sunshineBin: config.sunshineBin, sunshineConfig: config.sunshineConfig, profileDir: config.profileDir })) {
    if (!path || path.includes('\0')) throw new Error(`${name} path is required`);
  }
  return config;
}

const FORBIDDEN_CHROME_FLAGS = /playwright|webdriver|remote-debugging|headless|cdp/i;

export function buildChromeCommand(config) {
  const normalized = normalizeConfig(config);
  const args = [
    `--user-data-dir=${normalized.profileDir}`,
    `--window-size=${normalized.width},${normalized.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    'about:blank',
  ];
  if (args.some((arg) => FORBIDDEN_CHROME_FLAGS.test(arg))) {
    throw new Error('Chrome command contains a forbidden automation flag');
  }
  return [normalized.chromeBin, ...args];
}

export function buildSunshineCommand(config) {
  const normalized = normalizeConfig(config);
  // Sunshine 0.23.x accepts the config path as its positional argument.
  return [normalized.sunshineBin, normalized.sunshineConfig];
}

export function buildSunshineConfig(config) {
  const normalized = normalizeConfig(config);
  return [
    '# Disposable human-only pilot: LAN IPv4 only; do not expose to the public Internet.',
    `address_family = ${normalized.sunshineAddressFamily}`,
    'port = 47989',
    'upnp = disabled',
    'hevc_mode = 0',
    'av1_mode = 0',
    `resolutions = [${normalized.width}x${normalized.height}]`,
    `fps = [${normalized.fps}]`,
    '',
  ].join('\n');
}
