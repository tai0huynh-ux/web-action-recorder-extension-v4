import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { AgentError, redactUrl } from './errors.js';

export class BrowserController {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
    this.context = null;
    this.createdAtByPage = new WeakMap();
    this.targetIdByPage = new WeakMap();
    this.pageByTargetId = new Map();
    this.activeTargetId = undefined;
    this.nativeBridgePollTriggeredFor = new Set();
    this.nativeBridgeRestartedFor = new Set();
    this.pendingNativeBridgeRestartFor = null;
    this.extensionStatus = {
      configuredPath: config.extensionDir,
      loaded: false,
      extensionId: undefined,
      version: readManifestVersion(config.extensionDir),
      lastError: undefined
    };
  }

  async start() {
    if (this.context) return this.getState();
    const args = [
      `--disable-extensions-except=${this.config.extensionDir}`,
      `--load-extension=${this.config.extensionDir}`,
      `--window-size=${this.config.width},${this.config.height}`
    ];
    if (this.config.noSandbox) args.push('--no-sandbox');
    const ignoreDefaultArgs = ['--disable-dev-shm-usage'];
    if (!this.config.noSandbox) ignoreDefaultArgs.push('--no-sandbox');
    this.context = await chromium.launchPersistentContext(this.config.paths.profileDir, {
      executablePath: this.config.chromiumExecutable,
      headless: this.config.headless,
      chromiumSandbox: !this.config.noSandbox,
      ignoreDefaultArgs,
      viewport: { width: this.config.width, height: this.config.height },
      locale: this.config.locale,
      timezoneId: this.config.timezone,
      downloadsPath: this.config.paths.downloadsDir,
      env: browserEnvironment(process.env),
      args
    });
    for (const page of this.context.pages()) this.registerPage(page);
    this.context.on('page', (page) => this.registerPage(page));
    await this.refreshExtensionStatus();
    if (this.pendingNativeBridgeRestartFor && !this.nativeBridgeRestartedFor.has(this.pendingNativeBridgeRestartFor)) {
      const extensionId = this.pendingNativeBridgeRestartFor;
      this.pendingNativeBridgeRestartFor = null;
      this.nativeBridgeRestartedFor.add(extensionId);
      await this.stop();
      return this.start();
    }
    if (!this.context.pages().length) this.registerPage(await this.context.newPage());
    if (!this.activeTargetId) this.activeTargetId = this.firstOpenTargetId();
    return this.getState();
  }

  async stop(timeoutMs = 5000) {
    if (!this.context) return;
    const context = this.context;
    this.context = null;
    this.targetIdByPage = new WeakMap();
    this.pageByTargetId.clear();
    this.activeTargetId = undefined;
    await Promise.race([
      context.close(),
      new Promise((_, reject) => setTimeout(() => reject(new AgentError('browser_stop_timeout', 'Chromium close timed out', 500)), timeoutMs))
    ]);
  }

  async getState() {
    return {
      tabs: await this.listTabs(),
      extension: this.extensionStatus,
      profileDir: this.config.paths.profileDir
    };
  }

  async listTabs() {
    if (!this.context) return [];
    const pages = this.context.pages();
    const openPages = pages.filter((page) => !page.isClosed());
    if (!openPages.some((page) => this.getTargetId(page) === this.activeTargetId)) {
      this.activeTargetId = openPages.length ? this.getTargetId(openPages[0]) : undefined;
    }
    return Promise.all(openPages.map(async (page) => {
      const url = page.url();
      const targetId = this.getTargetId(page);
      return {
        targetId,
        title: await safeTitle(page),
        url: redactUrl(url),
        active: targetId === this.activeTargetId,
        createdAt: this.createdAtByPage.get(page),
        type: 'page',
        supported: isSupportedPageUrl(url)
      };
    }));
  }

  async openTab(url) {
    assertSafeHttpUrl(url);
    this.assertRunning();
    const page = await this.context.newPage();
    this.registerPage(page);
    await page.goto(url);
    await page.bringToFront();
    this.activeTargetId = this.getTargetId(page);
    return this.describePage(page, true);
  }

  async activateTab(targetId) {
    const page = await this.findPage(targetId);
    await page.bringToFront();
    this.activeTargetId = this.getTargetId(page);
    return this.describePage(page, true);
  }

  async navigateTab(targetId, url) {
    assertSafeHttpUrl(url);
    const page = await this.findPage(targetId);
    await page.goto(url);
    await page.bringToFront();
    this.activeTargetId = this.getTargetId(page);
    return this.describePage(page, true);
  }

  async openInternalPage(pageName) {
    this.assertRunning();
    const url = this.resolveInternalPage(pageName);
    const page = await this.context.newPage();
    this.registerPage(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    this.activeTargetId = this.getTargetId(page);
    return this.describePage(page, true);
  }

  async getSandboxStatus() {
    this.assertRunning();
    let page;
    try {
      page = await this.context.newPage();
      await page.goto('chrome://sandbox/', { waitUntil: 'domcontentloaded', timeout: 5000 });
      await page.waitForFunction(() => typeof globalThis.loadTimeData?.getBoolean === 'function', null, { timeout: 5000 });
      const status = await page.evaluate(() => Object.fromEntries([
        'suid',
        'userNs',
        'pidNs',
        'netNs',
        'seccompBpf',
        'seccompTsync',
        'sandboxGood',
      ].map((key) => [key, globalThis.loadTimeData.getBoolean(key)])));
      if (!status || Object.values(status).some((value) => typeof value !== 'boolean')) {
        throw new AgentError('sandbox_status_unavailable', 'Chromium sandbox status is unavailable', 503);
      }
      return { source: 'chrome://sandbox', ...status };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  resolveInternalPage(pageName) {
    const extensionId = this.extensionStatus.extensionId;
    const allowed = {
      settings: 'chrome://settings/',
      extensions: 'chrome://extensions/',
      downloads: 'chrome://downloads/',
      version: 'chrome://version/',
      flags: 'chrome://flags/'
    };
    if (pageName === 'extensionSidePanel' || pageName === 'extensionPage') {
      if (!extensionId) throw new AgentError('extension_not_loaded', 'Extension ID is not available', 409);
      return `chrome-extension://${extensionId}/ui/sidepanel.html?standalone=1`;
    }
    if (!allowed[pageName]) throw new AgentError('invalid_internal_page', 'Internal page is not allowed');
    return allowed[pageName];
  }

  async closeTab(targetId) {
    this.assertRunning();
    const page = this.pageByTargetId.get(targetId);
    if (!page || page.isClosed()) return { closed: false, reason: 'not_found' };
    const openPages = this.context.pages().filter((candidate) => !candidate.isClosed());
    if (openPages.length <= 1) {
      await page.goto('about:blank');
      this.activeTargetId = this.getTargetId(page);
      return { closed: false, reason: 'last_tab_kept_blank' };
    }
    await page.close();
    this.pageByTargetId.delete(targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = this.firstOpenTargetId();
    return { closed: true };
  }

  async refreshExtensionStatus() {
    const previousExtensionId = this.extensionStatus.extensionId;
    const manifest = readManifest(this.config.extensionDir);
    this.extensionStatus = {
      configuredPath: this.config.extensionDir,
      loaded: false,
      extensionId: previousExtensionId,
      version: manifest?.version,
      lastError: manifest ? undefined : 'manifest.json could not be read'
    };
    if (!manifest) return this.extensionStatus;
    if (!this.context) return this.extensionStatus;
    try {
      const extensionUrls = [
        ...this.context.serviceWorkers().map((worker) => worker.url()),
        ...this.context.pages().map((page) => page.url())
      ].filter((url) => url.startsWith('chrome-extension://'));
      let extensionId = previousExtensionId || extensionUrls.map(extractExtensionId).find(Boolean);
      let worker = this.context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://'));
      if (!worker) {
        worker = await this.context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => undefined);
      }
      if (!extensionId && worker?.url().startsWith('chrome-extension://')) {
        extensionId = extractExtensionId(worker.url());
      }
      const extensionPageLoaded = extensionId ? await this.verifyExtensionPage(extensionId) : false;
      if (extensionId && (worker?.url().startsWith('chrome-extension://') || extensionPageLoaded)) {
        this.extensionStatus = {
          configuredPath: this.config.extensionDir,
          loaded: true,
          extensionId,
          version: manifest?.version,
          lastError: undefined
        };
        if (this.ensureNativeMessagingManifest(extensionId)) this.pendingNativeBridgeRestartFor = extensionId;
        else await this.triggerNativeBridgePolling(extensionId);
      } else {
        this.extensionStatus.lastError = 'No extension target or loadable extension page detected';
      }
    } catch (error) {
      this.extensionStatus.lastError = error.message;
    }
    return this.extensionStatus;
  }

  ensureNativeMessagingManifest(extensionId) {
    const hostPath = process.env.WAR_NATIVE_HOST_PATH;
    if (!hostPath) return false;
    if (!path.isAbsolute(hostPath)) throw new AgentError('invalid_config', 'WAR_NATIVE_HOST_PATH must be absolute');
    const hostDir = path.join(os.homedir(), '.config', 'chromium', 'NativeMessagingHosts');
    fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(hostDir, 'com.web_action_recorder.native_bridge.json');
    const manifest = {
      name: 'com.web_action_recorder.native_bridge',
      description: 'Web Action Recorder container native bridge',
      path: hostPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (fs.existsSync(manifestPath) && fs.readFileSync(manifestPath, 'utf8') === serialized) return false;
    fs.writeFileSync(manifestPath, serialized, { mode: 0o600 });
    return true;
  }

  async triggerNativeBridgePolling(extensionId) {
    if (!process.env.WAR_NATIVE_HOST_PATH || this.nativeBridgePollTriggeredFor.has(extensionId)) return;
    this.nativeBridgePollTriggeredFor.add(extensionId);
    let page;
    try {
      page = await this.context.newPage();
      this.registerPage(page);
      await page.goto(`chrome-extension://${extensionId}/ui/sidepanel.html?standalone=1`, { waitUntil: 'domcontentloaded', timeout: 5000 });
      await page.evaluate(async () => {
        const data = await chrome.storage.local.get('war_settings');
        const settings = data.war_settings || {};
        await chrome.storage.local.set({ war_settings: { ...settings, nativeBridgeEnabled: false } });
        await chrome.storage.local.set({ war_settings: { ...settings, nativeBridgeEnabled: true } });
      });
      this.extensionStatus.nativeBridgeProbe = await page.evaluate((hostName) => new Promise((resolve) => {
        let port;
        const timer = setTimeout(() => {
          try { port?.disconnect?.(); } catch {}
          resolve({ ok: false, error: 'native_bridge_probe_timeout' });
        }, 3000);
        try {
          port = chrome.runtime.connectNative(hostName);
          port.onMessage.addListener((message) => {
            clearTimeout(timer);
            resolve({ ok: Boolean(message?.payload?.ok), type: message?.type, error: message?.payload?.error?.code });
            try { port.disconnect(); } catch {}
          });
          port.onDisconnect.addListener(() => {
            clearTimeout(timer);
            resolve({ ok: false, error: chrome.runtime.lastError?.message || 'native_bridge_disconnected' });
          });
          port.postMessage({
            protocolVersion: 'war-control.v2',
            messageId: `probe-${Date.now()}`,
            type: 'bridge.health',
            sentAt: new Date().toISOString(),
            payload: {}
          });
        } catch (error) {
          clearTimeout(timer);
          resolve({ ok: false, error: error.message });
        }
      }), 'com.web_action_recorder.native_bridge');
    } catch (error) {
      this.extensionStatus.nativeBridgeProbe = { ok: false, error: error.message };
      this.log('warn', 'browserController', 'native_bridge_poll_trigger_failed', { message: error.message });
    } finally {
      await page?.close().catch(() => {});
    }
  }

  async describePage(page, active = false) {
    const url = page.url();
    const targetId = this.getTargetId(page);
    return {
      targetId,
      title: await safeTitle(page),
      url: redactUrl(url),
      active: active || targetId === this.activeTargetId,
      createdAt: this.createdAtByPage.get(page),
      type: 'page',
      supported: isSupportedPageUrl(url)
    };
  }

  async findPage(targetId) {
    this.assertRunning();
    const page = this.pageByTargetId.get(targetId);
    if (!page || page.isClosed()) throw new AgentError('tab_not_found', 'Tab not found', 404);
    return page;
  }

  assertRunning() {
    if (!this.context) throw new AgentError('browser_not_running', 'Browser is not running', 409);
  }

  registerPage(page) {
    if (this.targetIdByPage.has(page)) return this.targetIdByPage.get(page);
    const targetId = `tab-${crypto.randomUUID()}`;
    this.targetIdByPage.set(page, targetId);
    this.pageByTargetId.set(targetId, page);
    this.createdAtByPage.set(page, new Date().toISOString());
    page.once?.('close', () => {
      this.pageByTargetId.delete(targetId);
      if (this.activeTargetId === targetId) this.activeTargetId = this.firstOpenTargetId();
    });
    return targetId;
  }

  getTargetId(page) {
    return this.targetIdByPage.get(page) || this.registerPage(page);
  }

  firstOpenTargetId() {
    for (const [targetId, page] of this.pageByTargetId.entries()) {
      if (!page.isClosed()) return targetId;
    }
    return undefined;
  }

  async verifyExtensionPage(extensionId) {
    if (!this.context) return false;
    const url = `chrome-extension://${extensionId}/ui/sidepanel.html?standalone=1`;
    let page;
    try {
      page = await this.context.newPage();
      this.registerPage(page);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });
      return page.url().startsWith(`chrome-extension://${extensionId}/`);
    } catch (error) {
      this.extensionStatus.lastError = error.message;
      return false;
    } finally {
      await page?.close().catch(() => {});
    }
  }
}

export function browserEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/(credential|password|secret|token)/i.test(key)));
}

export function assertSafeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length < 8 || rawUrl.length > 2048) {
    throw new AgentError('invalid_url', 'URL length is invalid');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new AgentError('invalid_url', 'URL is invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AgentError('invalid_url', 'Only http and https URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new AgentError('invalid_url', 'URL credentials are not allowed');
  }
  return parsed.toString();
}

export function isSupportedPageUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'chrome:' || protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

async function safeTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

function extractExtensionId(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'chrome-extension:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}

function readManifestVersion(extensionDir) {
  return readManifest(extensionDir)?.version;
}

function readManifest(extensionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  } catch {
    return undefined;
  }
}
