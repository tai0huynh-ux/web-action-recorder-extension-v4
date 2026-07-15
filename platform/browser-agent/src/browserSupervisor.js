import { EventEmitter } from 'node:events';

const RESTART_BACKOFF_MS = [1000, 2000, 5000];

export class BrowserSupervisor extends EventEmitter {
  constructor({ controller, log = () => {}, restartWindowMs = 60000, maxRestarts = 3 } = {}) {
    super();
    this.controller = controller;
    this.log = log;
    this.restartWindowMs = restartWindowMs;
    this.maxRestarts = maxRestarts;
    this.state = 'stopped';
    this.startPromise = null;
    this.stopPromise = null;
    this.restartPromise = null;
    this.restartTimes = [];
    this.manualStop = false;
  }

  async start() {
    if (this.state === 'running' || this.state === 'degraded') return this.getState();
    if (this.startPromise) return this.startPromise;
    this.manualStop = false;
    this.state = 'starting';
    this.startPromise = (async () => {
      try {
        await this.controller.start();
        const extensionLoaded = this.controller.extensionStatus?.loaded !== false;
        this.state = extensionLoaded ? 'running' : 'degraded';
        this.log('info', 'browserSupervisor', 'browser_started', { browserState: this.state });
        return this.getState();
      } catch (error) {
        this.state = 'crashed';
        this.log('error', 'browserSupervisor', 'browser_start_failed', { message: error.message, browserState: this.state });
        throw error;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async stop() {
    this.manualStop = true;
    if (this.state === 'stopped') return this.getState();
    if (this.stopPromise) return this.stopPromise;
    this.state = 'stopping';
    this.stopPromise = (async () => {
      try {
        await this.controller.stop();
      } finally {
        this.state = 'stopped';
        this.stopPromise = null;
      }
      return this.getState();
    })();
    return this.stopPromise;
  }

  async restart() {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      await this.stop();
      this.manualStop = false;
      return this.start();
    })().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  async handleCrash(reason = 'browser_crashed') {
    if (this.manualStop) return this.getState();
    this.state = 'crashed';
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((time) => now - time < this.restartWindowMs);
    if (this.restartTimes.length >= this.maxRestarts) {
      this.state = 'degraded';
      this.log('error', 'browserSupervisor', 'restart_budget_exhausted', { reason, browserState: this.state });
      return this.getState();
    }
    const attempt = this.restartTimes.length;
    this.restartTimes.push(now);
    await sleep(RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)]);
    return this.restart();
  }

  async getBrowserState() {
    const browser = await this.controller.getState();
    return {
      ...this.getState(),
      browser
    };
  }

  getState() {
    return {
      browserState: this.state,
      extensionLoaded: this.controller.extensionStatus?.loaded === true,
      extension: this.controller.extensionStatus
    };
  }

  installSignalHandlers() {
    const cleanup = async () => {
      await this.stop().catch((error) => {
        this.log('error', 'browserSupervisor', 'signal_cleanup_failed', { message: error.message });
      });
      process.exit(0);
    };
    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
