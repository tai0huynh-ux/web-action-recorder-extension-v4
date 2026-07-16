import { mapError } from './errorMapper.js';

export function isTrustedSender(event, mainWindow) {
  if (!event?.sender || event.sender !== mainWindow?.webContents || event.sender.isDestroyed?.() || event.senderFrame !== event.sender.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.protocol === 'war-controller:' && url.hostname === 'app' && url.pathname === '/'; } catch { return false; }
}

export function registerIpcHandlers({ ipcMain, mainWindow, application, channels }) {
  const handlers = new Map([[channels.bootstrap, () => application.getBootstrapState()], [channels.runtime, () => application.getRuntimeStatus()]]);
  for (const [channel, handler] of handlers) ipcMain.handle(channel, (event, payload) => { try { if (!isTrustedSender(event, mainWindow())) { const error = new Error('Sender rejected'); error.code = 'AUTH_DENIED'; throw error; } if (payload !== undefined) { const encoded = JSON.stringify(payload); if (encoded.length > 256 * 1024) { const error = new Error('Payload rejected'); error.code = 'INVALID_TARGET'; throw error; } } return handler(payload); } catch (error) { return mapError(error); } });
  return () => { for (const channel of handlers.keys()) ipcMain.removeHandler(channel); };
}
