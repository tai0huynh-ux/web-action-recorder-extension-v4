const DEFAULTS = Object.freeze({
  chromeBin: '/usr/bin/google-chrome',
  sunshineBin: '/usr/bin/sunshine',
  sunshineConfig: '/etc/sunshine/sunshine.conf',
  profileDir: '/data/chrome-profile',
  sunshineAddress: '0.0.0.0',
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

  const address = String(value('sunshineAddress', DEFAULTS.sunshineAddress)).trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    throw new Error('sunshineAddress must be an IPv4 address');
  }

  const config = {
    chromeBin: String(value('chromeBin', DEFAULTS.chromeBin)).trim(),
    sunshineBin: String(value('sunshineBin', DEFAULTS.sunshineBin)).trim(),
    sunshineConfig: String(value('sunshineConfig', DEFAULTS.sunshineConfig)).trim(),
    profileDir: String(value('profileDir', DEFAULTS.profileDir)).trim(),
    sunshineAddress: address,
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
    `address = ${normalized.sunshineAddress}`,
    'port = 47989',
    'upnp = disabled',
    'hevc_mode = 0',
    'av1_mode = 0',
    `resolution = [${normalized.width}x${normalized.height}]`,
    `fps = [${normalized.fps}]`,
    '',
  ].join('\n');
}
