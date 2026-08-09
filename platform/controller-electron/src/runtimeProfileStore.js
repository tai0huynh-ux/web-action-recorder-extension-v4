import nodeFs from 'node:fs';
import nodePath from 'node:path';

const SCHEMA_VERSION = 1;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function createControllerRuntimeProfileStore({ fs = nodeFs, path = nodePath, filePath } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('Runtime profile file path is required');
  const backupPath = `${filePath}.last-good`;

  return Object.freeze({
    async load() {
      const primary = await readProfile(fs, filePath);
      if (primary.status === 'loaded') return primary;
      if (primary.status === 'missing') {
        const backup = await readProfile(fs, backupPath);
        return backup.status === 'loaded' ? backup : primary;
      }
      const backup = await readProfile(fs, backupPath);
      return backup.status === 'loaded' ? backup : primary;
    },
    async save(profile) {
      const validated = validateRuntimeProfile(profile);
      if (!validated.ok) throw new Error(validated.error);
      const directory = path.dirname(filePath);
      const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
      await fs.promises.mkdir(directory, { recursive: true });
      try {
        await fs.promises.writeFile(temporaryPath, `${JSON.stringify(validated.profile)}\n`, { encoding: 'utf8', mode: 0o600 });
        try {
          await fs.promises.rename(filePath, backupPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        await fs.promises.rename(temporaryPath, filePath);
      } catch (error) {
        try { await fs.promises.unlink(temporaryPath); } catch { /* Best-effort cleanup only. */ }
        throw error;
      }
    },
  });
}

export function validateRuntimeProfile(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['schemaVersion', 'wss', 'imagePin'])) return invalid('Runtime profile has an invalid shape');
  if (value.schemaVersion !== SCHEMA_VERSION) return invalid('Runtime profile schema is unsupported');
  const wss = value.wss;
  if (!isPlainObject(wss) || !hasOnlyKeys(wss, ['enabled', 'host', 'port', 'lanBindingApproved', 'certificatePath', 'privateKeyPath'])) {
    return invalid('Runtime profile WSS settings are invalid');
  }
  if (wss.enabled !== true || !isHost(wss.host) || !isStablePort(wss.port) || typeof wss.lanBindingApproved !== 'boolean' || !isPath(wss.certificatePath) || !isPath(wss.privateKeyPath)) {
    return invalid('Runtime profile WSS values are invalid');
  }
  if (!LOOPBACK_HOSTS.has(wss.host) && wss.lanBindingApproved !== true) return invalid('Runtime profile LAN binding is not approved');
  if (Object.hasOwn(value, 'imagePin') && !isImmutableImagePin(value.imagePin)) return invalid('Runtime profile requires an immutable image pin');
  return {
    ok: true,
    profile: deepFreeze({ schemaVersion: SCHEMA_VERSION, wss: { ...wss }, ...(Object.hasOwn(value, 'imagePin') ? { imagePin: value.imagePin } : {}) }),
  };
}

async function readProfile(fs, filePath) {
  let text;
  try {
    text = await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', profile: null };
    return { status: 'invalid', profile: null, error: 'Runtime profile could not be read' };
  }
  try {
    const validated = validateRuntimeProfile(JSON.parse(text));
    return validated.ok
      ? { status: 'loaded', profile: structuredClone(validated.profile) }
      : { status: 'invalid', profile: null, error: validated.error };
  } catch {
    return { status: 'invalid', profile: null, error: 'Runtime profile contains invalid JSON' };
  }
}

function invalid(error) { return { ok: false, error }; }
function hasOnlyKeys(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isHost(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 255 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
function isStablePort(value) { return Number.isInteger(value) && value >= 1 && value <= 65535; }
function isPath(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value); }
export function isImmutableImagePin(value) {
  return typeof value === 'string'
    && (/^sha256:[a-f0-9]{64}$/i.test(value)
      || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}@sha256:[a-f0-9]{64}$/i.test(value));
}
function deepFreeze(value) { for (const child of Object.values(value || {})) if (child && typeof child === 'object') deepFreeze(child); return Object.freeze(value); }
