export const DEFAULT_CONTROLLER_SETTINGS = Object.freeze({
  locale: 'vi',
  theme: 'light',
  workspace: Object.freeze({
    leftWidth: 280,
    centerWidth: 420,
    graphCollapsed: false,
  }),
});

export function createControllerSettingsStore({ fs, path, filePath }) {
  if (!fs || !path || !filePath) throw new Error('Settings store dependencies are required');
  return {
    async get() {
      return readSettings({ fs, filePath });
    },
    async update(patch = {}) {
      const current = await readSettings({ fs, filePath });
      const next = normalizeSettings({
        ...current,
        ...patch,
        workspace: {
          ...current.workspace,
          ...(patch.workspace || {}),
        },
      });
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      return next;
    },
  };
}

export function normalizeSettings(value = {}) {
  const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
  const aliases = value.hostAliases && typeof value.hostAliases === 'object' && !Array.isArray(value.hostAliases)
    ? Object.fromEntries(Object.entries(value.hostAliases)
      .filter(([key, alias]) => /^[A-Za-z0-9_.:-]{1,120}$/.test(key) && typeof alias === 'string')
      .map(([key, alias]) => [key, alias.trim().slice(0, 120)])
      .filter(([, alias]) => alias))
    : {};
  const containerHosts = Array.isArray(value.containerHosts)
    ? value.containerHosts.map(normalizeContainerHost).filter(Boolean)
    : [];
  const trashedContainerHosts = Array.isArray(value.trashedContainerHosts)
    ? value.trashedContainerHosts.map(normalizeTrashedContainerHost).filter(Boolean)
    : [];
  const purgedContainerHostIds = Array.isArray(value.purgedContainerHostIds)
    ? value.purgedContainerHostIds.filter((id) => typeof id === 'string' && !['__proto__', 'constructor', 'prototype'].includes(id) && /^[A-Za-z0-9_.:-]{1,120}$/.test(id)).slice(0, 200)
    : [];
  return {
    locale: value.locale === 'en' ? 'en' : 'vi',
    theme: value.theme === 'dark' ? 'dark' : 'light',
    workspace: {
      leftWidth: clampInteger(workspace.leftWidth, 220, 380, DEFAULT_CONTROLLER_SETTINGS.workspace.leftWidth),
      centerWidth: clampInteger(workspace.centerWidth, 320, 600, DEFAULT_CONTROLLER_SETTINGS.workspace.centerWidth),
      graphCollapsed: Boolean(workspace.graphCollapsed),
    },
    ...(Object.keys(aliases).length ? { hostAliases: aliases } : {}),
    ...(containerHosts.length ? { containerHosts } : {}),
    ...(trashedContainerHosts.length ? { trashedContainerHosts } : {}),
    ...(purgedContainerHostIds.length ? { purgedContainerHostIds } : {}),
  };
}

function normalizeTrashedContainerHost(value) {
  const host = normalizeContainerHost(value);
  if (!host) return null;
  const deletedAt = typeof value.deletedAt === 'string' && !/[\u0000-\u001f\u007f]/.test(value.deletedAt)
    ? value.deletedAt.slice(0, 40)
    : null;
  return deletedAt ? { ...host, deletedAt } : null;
}

function normalizeContainerHost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = normalizeHostText(value.id, 1, 120);
  const name = normalizeHostText(value.name, 1, 80);
  const target = normalizeHostText(value.target, 3, 255);
  const identityFile = normalizeHostText(value.identityFile, 1, 1024);
  if (!id || !name || !target || !identityFile || !isSshTarget(target)) return null;
  const image = normalizeHostText(value.image, 1, 256) || 'war-browser-agent:phase1';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(image)) return null;
  const controllerHost = normalizeHostText(value.controllerHost, 1, 255);
  const controllerCaPath = normalizeRemotePath(value.controllerCaPath, '/etc/war/controller-ca.pem');
  const seccompProfilePath = normalizeRemotePath(value.seccompProfilePath, '/etc/war/security/chromium-userns-seccomp.json');
  const ipv6Interface = normalizeHostText(value.ipv6Interface, 1, 32);
  const ipv6Prefix = normalizeHostText(value.ipv6Prefix, 1, 80);
  const ipv6Driver = value.ipv6Driver === 'bridge' ? 'bridge' : 'macvlan';
  return {
    id,
    name,
    target,
    identityFile,
    image,
    controllerHost: controllerHost || null,
    controllerCaPath,
    seccompProfilePath,
    ipv6Interface: ipv6Interface || null,
    ipv6Prefix: ipv6Prefix || null,
    ipv6Driver,
  };
}

function normalizeHostText(value, min, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function normalizeRemotePath(value, fallback) {
  const text = normalizeHostText(value, 1, 512);
  return text && /^\/[A-Za-z0-9._/-]+$/.test(text) ? text : fallback;
}

function isSshTarget(value) {
  return /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])$/.test(value);
}

async function readSettings({ fs, filePath }) {
  try {
    const source = await fs.promises.readFile(filePath, 'utf8');
    return normalizeSettings(JSON.parse(source));
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeSettings();
    return normalizeSettings();
  }
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
