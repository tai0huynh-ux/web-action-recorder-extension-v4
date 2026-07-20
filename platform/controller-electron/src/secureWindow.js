const REQUIRED = Object.freeze({ contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });

export function buildSecureWebPreferences(overrides = {}) {
  for (const [key, value] of Object.entries(REQUIRED)) if (key in overrides && overrides[key] !== value) throw new Error(`Insecure ${key} override rejected`);
  return Object.freeze({ ...REQUIRED, preload: overrides.preload });
}

export function secureWindowOptions(preload, icon) {
  return { width: 1100, height: 760, show: false, ...(icon ? { icon } : {}), webPreferences: buildSecureWebPreferences({ preload }) };
}
