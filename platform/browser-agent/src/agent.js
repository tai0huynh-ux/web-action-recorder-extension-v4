import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureDataDirs, serializeConfig } from './config.js';
import { loadOrCreateDeviceIdentity } from './deviceIdentity.js';
import { BrowserController } from './browserController.js';
import { BrowserSupervisor } from './browserSupervisor.js';
import { ControlDispatcher, supportedCommandTypes } from './controlDispatcher.js';
import { createHttpServer, listen } from './httpServer.js';
import { createLogger } from './errors.js';
import { createWorkflowRegistry } from './workflowRegistry.js';
import { NativeBridgeHandler } from './nativeBridgeHandler.js';
import { LocalSocketServer } from './localSocketServer.js';
import { ControllerSessionClient } from './controllerSessionClient.js';
import { TerminalOutbox } from './terminalOutbox.js';
import { PROTOCOL_VERSION } from '../../protocol/src/protocolV2.js';

export async function main() {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  const config = loadConfig();
  delete process.env.WAR_CONTROLLER_SESSION_CREDENTIAL;
  ensureDataDirs(config);
  const identity = loadOrCreateDeviceIdentity(config.paths.deviceDir, () => new Date(), config.managedDeviceId);
  const log = createLogger({ deviceId: identity.deviceId });
  log('info', 'agent', 'config_loaded', { config: serializeConfig(config) });
  if (config.noSandbox) {
    log('warn', 'agent', 'chromium_no_sandbox_enabled', { message: 'WAR_BROWSER_NO_SANDBOX is enabled by explicit configuration' });
  }
  const controller = new BrowserController(config, log);
  const supervisor = new BrowserSupervisor({ controller, log });
  supervisor.installSignalHandlers();
  const dispatcher = new ControlDispatcher({ supervisor, controller, deviceId: identity.deviceId, config, log });
  let controllerSession = null;
  const registry = createWorkflowRegistry(config, log);
  const terminalOutbox = new TerminalOutbox({ filePath: path.join(config.dataDir, 'terminal-outbox.json'), log });
  const nativeBridge = new NativeBridgeHandler({
    identity,
    registry,
    terminalOutbox,
    version: packageJson.version,
    supervisor,
    dispatcher,
    log,
    onExecutionEnvelope: (envelope) => {
      if (!controllerSession) throw new Error('Controller session is unavailable');
      const terminal = envelope.type === 'execution.result' || envelope.type === 'execution.cancelled';
      return controllerSession.sendExecutionEnvelope(envelope, { expectResponse: terminal });
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
        const sentAt = new Date().toISOString();
        nativeBridge.handle({
          protocolVersion: PROTOCOL_VERSION,
          messageId: `dispatch-rejected-${dispatch.jobId}`,
          type: 'execution.result',
          sentAt,
          deadline: new Date(Date.parse(sentAt) + 30000).toISOString(),
          deviceId: identity.deviceId,
          jobId: dispatch.jobId,
          idempotencyKey: `${dispatch.jobId}-dispatch-rejected`,
          payload: {
            jobId: dispatch.jobId,
            eventType: 'job_failed',
            sentAt,
            message: error.message,
            result: { ok: false, error: 'dispatch_rejected' }
          }
        }).catch((forwardError) => log('warn', 'agent', 'dispatch_rejection_persist_failed', { jobId: dispatch.jobId, message: forwardError.message }));
      }
    });
    controllerSession.on('cancel', (cancel) => {
      nativeBridge.enqueueCancel(cancel);
    });
    controllerSession.on('remoteControl', (request) => {
      executeRemoteControlRequest({ request, controllerSession, controller, dispatcher, identity, log }).catch((error) => {
        log('warn', 'agent', 'remote_control_response_failed', { message: error.message });
      });
    });
    controllerSession.on('authenticated', () => {
      nativeBridge.flushTerminalOutbox().catch((error) => log('warn', 'agent', 'terminal_outbox_flush_failed', { message: error.message }));
    });
    controllerSession.on('originInventoryRequest', (request) => {
      const workflows = registry.listMetadata();
      controllerSession.sendOriginResponse(request, {
        workflows,
        counts: { workflows: workflows.length },
      });
    });
    controllerSession.on('originWorkflowGet', (request) => {
      const workflow = registry.getRevision(request.payload?.workflowId, request.payload?.revision);
      controllerSession.sendOriginResponse(request, workflow ? { workflow } : { error: { code: 'WORKFLOW_NOT_FOUND', message: 'Origin workflow not found' } });
    });
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
  controllerSession?.start();
}

async function executeRemoteControlRequest({ request, controllerSession, controller, dispatcher, identity, log }) {
  const payload = request?.payload || {};
  const command = String(payload.command || '');
  const commandPayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};
  try {
    await waitUntil(payload.syncAt);
    let result;
    if (command === 'remote.capture') {
      result = await controller.captureRemoteFrame(commandPayload);
    } else {
      if (!supportedCommandTypes.includes(command)) throw new Error('Remote command is not supported');
      const deadline = request.deadline ? Date.parse(request.deadline) : Date.now() + 10000;
      const deadlineMs = Math.max(0, deadline - Date.now());
      result = await dispatcher.dispatch({
        protocol: 'war-control.v1',
        messageId: `remote-${request.messageId}`,
        type: command,
        deviceId: identity.deviceId,
        timestamp: new Date().toISOString(),
        deadlineMs,
        idempotencyKey: payload.idempotencyKey || `remote-${request.messageId}`,
        payload: commandPayload
      });
    }
    return controllerSession.sendRemoteControlResponse(request, {
      ok: true,
      requestId: payload.requestId || request.messageId,
      result: command === 'remote.capture' ? { captured: true, targetId: result.targetId } : result,
      ...(command === 'remote.capture' ? { frame: result } : {})
    });
  } catch (error) {
    log('warn', 'agent', 'remote_control_failed', { command, message: error.message });
    return controllerSession.sendRemoteControlResponse(request, {
      ok: false,
      requestId: payload.requestId || request.messageId,
      error: { code: error.code || 'REMOTE_CONTROL_FAILED', message: String(error.message || 'Remote control failed').slice(0, 300) }
    });
  }
}

async function waitUntil(syncAt) {
  if (!syncAt) return;
  const target = Date.parse(syncAt);
  if (!Number.isFinite(target)) return;
  const delay = Math.min(500, Math.max(0, target - Date.now()));
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
