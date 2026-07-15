import fs from 'node:fs';
import { loadConfig, ensureDataDirs, serializeConfig } from './config.js';
import { loadOrCreateDeviceIdentity } from './deviceIdentity.js';
import { BrowserController } from './browserController.js';
import { BrowserSupervisor } from './browserSupervisor.js';
import { ControlDispatcher } from './controlDispatcher.js';
import { createHttpServer, listen } from './httpServer.js';
import { createLogger } from './errors.js';

export async function main() {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const config = loadConfig();
  ensureDataDirs(config);
  const identity = loadOrCreateDeviceIdentity(config.paths.deviceDir);
  const log = createLogger({ deviceId: identity.deviceId });
  log('info', 'agent', 'config_loaded', { config: serializeConfig(config) });
  if (config.noSandbox) {
    log('warn', 'agent', 'chromium_no_sandbox_enabled', { message: 'WAR_BROWSER_NO_SANDBOX is enabled by explicit configuration' });
  }
  const controller = new BrowserController(config, log);
  const supervisor = new BrowserSupervisor({ controller, log });
  supervisor.installSignalHandlers();
  const dispatcher = new ControlDispatcher({ supervisor, controller, deviceId: identity.deviceId, config, log });
  if (config.autoStartBrowser) {
    await supervisor.start().catch((error) => {
      log('error', 'agent', 'auto_start_failed', { message: error.message });
    });
  }
  const server = createHttpServer({ config, identity, supervisor, dispatcher, version: packageJson.version, log });
  await listen(server, config);
  log('info', 'agent', 'http_listening', { host: config.host, port: config.port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      component: 'agent',
      event: 'fatal',
      message: error.message
    }));
    process.exit(1);
  });
}
