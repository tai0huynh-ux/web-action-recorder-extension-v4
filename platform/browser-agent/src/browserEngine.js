import { chromium } from 'playwright-core';

// Engine metadata selects a pinned browser binary; no vendor wrapper is loaded at runtime.
export class BrowserEngine {
  constructor(config) {
    this.config = config;
  }

  async launchPersistentContext(profileDir, options) {
    return chromium.launchPersistentContext(profileDir, {
      ...options,
      executablePath: this.config.browserEngine.executable,
    });
  }

  state(browserVersion) {
    return {
      name: this.config.browserEngine.name,
      version: this.config.browserEngine.version,
      pinnedVersion: this.config.browserEngine.pinnedVersion,
      ...(browserVersion ? { browserVersion } : {}),
    };
  }
}
