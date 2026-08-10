import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, session, shell } from 'electron';
import { createElectronControllerRuntime } from './electronRuntime.js';
import { maybeRunPackagedSmoke } from '../release/packagedSmoke.js';

const runtime = createElectronControllerRuntime({
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
});

runtime.start().then(async () => {
  await maybeRunPackagedSmoke({ app, runtime });
}).catch((error) => {
  process.exitCode = 1;
  console.error(JSON.stringify({
    level: 'fatal',
    component: 'controller-electron',
    code: error?.code || 'STARTUP_FAILED',
    message: 'Electron Controller failed to start',
  }));
  app.quit();
});
