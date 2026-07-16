import fs from 'node:fs';
import { loadConfig, ensureDataDirs, serializeConfig } from './config.js';
import { loadOrCreateDeviceIdentity } from './deviceIdentity.js';
import { BrowserController } from './browserController.js';
import { BrowserSupervisor } from './browserSupervisor.js';
import { ControlDispatcher } from './controlDispatcher.js';
import { createHttpServer, listen } from './httpServer.js';
import { createLogger } from './errors.js';
import { createWorkflowRegistry } from './workflowRegistry.js';
import { NativeBridgeHandler } from './nativeBridgeHandler.js';
import { LocalSocketServer } from './localSocketServer.js';
import { ControllerSessionClient } from './controllerSessionClient.js';

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
  const registry = createWorkflowRegistry(config, log);
  let controllerSession = null;
  const nativeBridge = new NativeBridgeHandler({
    identity,
    registry,
    version: packageJson.version,
    supervisor,
    dispatcher,
    log,
    onExecutionEnvelope: (envelope) => {
      if (!controllerSession) return;
      const event = envelope.payload || {};
      const sendResult = envelope.type === 'execution.cancelled'
        ? controllerSession.sendExecutionCancelled({ jobId: envelope.jobId || event.jobId, idempotencyKey: envelope.idempotencyKey })
        : controllerSession.sendExecutionEvent({
            jobId: envelope.jobId || event.jobId,
            eventType: event.eventType,
            message: event.message,
            result: event.result,
            idempotencyKey: envelope.idempotencyKey
          });
      Promise.resolve(sendResult).catch((error) => {
        log('warn', 'agent', 'controller_execution_event_forward_failed', {
          jobId: envelope.jobId || event.jobId,
          message: error.message
        });
      });
    }
  });
  if (config.controllerWssUrl) {
    controllerSession = new ControllerSessionClient({
      url: config.controllerWssUrl,
      credential: config.controllerSessionCredential,
      identity,
      version: packageJson.version,
      minReconnectMs: config.controllerReconnectMinMs,
      maxReconnectMs: config.controllerReconnectMaxMs,
      maxPending: config.controllerMaxPendingRequests,
      maxQueue: config.controllerMaxOutboundQueue,
      log
    });
    controllerSession.on('dispatch', (dispatch) => {
      log('info', 'agent', 'controller_dispatch_received', { jobId: dispatch.jobId, workflowId: dispatch.workflowId });
      try {
        nativeBridge.enqueueDispatch(dispatch);
      } catch (error) {
        log('warn', 'agent', 'controller_dispatch_rejected', { jobId: dispatch.jobId, message: error.message });
        controllerSession.sendExecutionEvent({
          jobId: dispatch.jobId,
          eventType: 'job_failed',
          message: error.message,
          result: { ok: false, error: 'dispatch_rejected' },
          idempotencyKey: `${dispatch.jobId}-dispatch-rejected`
        });
      }
    });
    controllerSession.on('cancel', (cancel) => {
      nativeBridge.enqueueCancel(cancel);
    });
    controllerSession.start();
    process.once('SIGTERM', () => controllerSession?.gracefulShutdown());
    process.once('SIGINT', () => controllerSession?.gracefulShutdown());
  }
  const socketServer = new LocalSocketServer({
    socketPath: config.nativeBridgeSocketPath,
    maxPayloadBytes: config.nativeBridgeMaxPayloadBytes,
    idleTimeoutMs: config.nativeBridgeIdleTimeoutMs,
    maxConnections: config.nativeBridgeMaxConnections,
    handler: (message) => nativeBridge.handle(message),
    log
  });
  await socketServer.start();
  log('info', 'agent', 'native_bridge_socket_listening', { socketPath: config.nativeBridgeSocketPath });
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
