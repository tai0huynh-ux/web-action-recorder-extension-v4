import net from 'node:net';

const DEFAULT_PORT = 47989;
const DEFAULT_APP = 'Desktop';
const ACTIONS = new Set(['pair', 'stream']);

export function normalizeMoonlightDescriptor(descriptor = {}) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw codedError('INTERACTIVE_DESCRIPTOR_REQUIRED', 'Interactive connection descriptor is required');
  }
  const host = String(descriptor.host || descriptor.address || '').trim();
  if (!isPrivateIpv4(host)) {
    throw codedError('INTERACTIVE_DESCRIPTOR_INVALID', 'Moonlight host must be a private LAN IPv4 address');
  }
  const port = descriptor.port === undefined ? DEFAULT_PORT : Number(descriptor.port);
  if (!Number.isInteger(port) || port !== DEFAULT_PORT) {
    throw codedError('INTERACTIVE_DESCRIPTOR_INVALID', `Moonlight base port must be ${DEFAULT_PORT}`);
  }
  const app = String(descriptor.app || descriptor.application || DEFAULT_APP).trim();
  if (!app || app.length > 80 || /[\u0000-\u001f\u007f]/.test(app)) {
    throw codedError('INTERACTIVE_DESCRIPTOR_INVALID', 'Moonlight application name is invalid');
  }
  return Object.freeze({ host, port, app, protocol: 'moonlight' });
}

export function normalizeMoonlightAction(action) {
  const normalized = String(action || 'stream').trim().toLowerCase();
  if (!ACTIONS.has(normalized)) {
    throw codedError('INTERACTIVE_ACTION_INVALID', 'Interactive action must be pair or stream');
  }
  return normalized;
}

export function buildMoonlightArguments(action, descriptor) {
  const normalizedAction = normalizeMoonlightAction(action);
  const connection = normalizeMoonlightDescriptor(descriptor);
  if (normalizedAction === 'pair') return ['pair', connection.host];
  return [
    'stream', connection.host, connection.app,
    '--720', '--fps', '30',
    '--video-codec', 'H.264',
    '--display-mode', 'windowed',
    '--absolute-mouse',
    '--capture-system-keys', 'always',
  ];
}

export function resolveMoonlightExecutable({ env = process.env, fs, path }) {
  const explicit = String(env.WAR_MOONLIGHT_EXE || '').trim();
  const candidates = [
    explicit,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Moonlight Game Streaming', 'Moonlight.exe') : '',
    env.ProgramW6432 ? path.join(env.ProgramW6432, 'Moonlight Game Streaming', 'Moonlight.exe') : '',
    'C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe',
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate) || candidate.includes('\0')) continue;
    try {
      if (typeof fs.existsSync === 'function' && fs.existsSync(candidate)) return candidate;
      fs.accessSync(candidate, fs.constants?.X_OK ?? fs.constants?.F_OK ?? 0);
      return candidate;
    } catch {}
  }
  throw codedError('INTERACTIVE_NOT_CONFIGURED', 'Moonlight is not installed or WAR_MOONLIGHT_EXE is invalid');
}

export function launchMoonlight({ action, descriptor, env, fs, path, spawn }) {
  if (typeof spawn !== 'function') throw codedError('INTERACTIVE_NOT_CONFIGURED', 'Moonlight launcher is unavailable');
  const normalizedAction = normalizeMoonlightAction(action);
  const connection = normalizeMoonlightDescriptor(descriptor);
  const executable = resolveMoonlightExecutable({ env, fs, path });
  const args = buildMoonlightArguments(normalizedAction, connection);
  let child;
  try {
    child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    child?.unref?.();
  } catch {
    throw codedError('INTERACTIVE_LAUNCH_FAILED', 'Moonlight could not be started');
  }
  return Object.freeze({
    status: normalizedAction === 'pair' ? 'pairing' : 'opened',
    action: normalizedAction,
    host: connection.host,
    port: connection.port,
    app: connection.app,
    pid: Number.isInteger(child?.pid) ? child.pid : null,
  });
}

function isPrivateIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
