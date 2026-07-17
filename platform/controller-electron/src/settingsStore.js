export const DEFAULT_CONTROLLER_SETTINGS = Object.freeze({
  locale: 'vi',
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
  return {
    locale: value.locale === 'en' ? 'en' : 'vi',
    workspace: {
      leftWidth: clampInteger(workspace.leftWidth, 220, 380, DEFAULT_CONTROLLER_SETTINGS.workspace.leftWidth),
      centerWidth: clampInteger(workspace.centerWidth, 320, 600, DEFAULT_CONTROLLER_SETTINGS.workspace.centerWidth),
      graphCollapsed: Boolean(workspace.graphCollapsed),
    },
  };
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
