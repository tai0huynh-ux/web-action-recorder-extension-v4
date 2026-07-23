export function assertTrustedIpcSender(event, { mainWindow, allowedWindows, allowedPaths = ['/', '/index.html'] } = {}) {
  const error = () => authDenied();
  const expectedWebContents = typeof mainWindow === 'function' ? mainWindow()?.webContents : mainWindow?.webContents;
  const extra = typeof allowedWindows === 'function' ? allowedWindows() : allowedWindows;
  const allowed = Array.isArray(extra) ? extra : extra ? [...extra] : [];
  const trusted = expectedWebContents && event?.sender === expectedWebContents
    || allowed.some((window) => window?.webContents === event?.sender);
  if (!event?.sender || !trusted) throw error();
  if (event.sender.isDestroyed?.()) throw error();
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw error();
  if (event.senderFrame.parent) throw error();
  if (event.senderFrame.top && event.senderFrame.top !== event.senderFrame) throw error();
  if (event.senderFrame.url?.startsWith?.('devtools://')) throw error();

  let url;
  try {
    url = new URL(event.senderFrame.url);
  } catch {
    throw error();
  }
  if (url.protocol !== 'war-controller:' || url.hostname !== 'app') throw error();
  if (!allowedPaths.includes(url.pathname)) throw error();
  return true;
}

function authDenied() {
  const denied = new Error('Sender rejected');
  denied.code = 'AUTH_DENIED';
  return denied;
}
