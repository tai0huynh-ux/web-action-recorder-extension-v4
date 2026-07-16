import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { createElectronControllerRuntime } from './electronRuntime.js';

const runtime = createElectronControllerRuntime({
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
});

runtime.start().catch((error) => {
  process.exitCode = 1;
  console.error(JSON.stringify({
    level: 'fatal',
    component: 'controller-electron',
    code: error?.code || 'STARTUP_FAILED',
    message: 'Electron Controller failed to start',
  }));
  app.quit();
});
