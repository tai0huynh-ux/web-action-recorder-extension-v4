import { app, BrowserWindow } from 'electron';
app.enableSandbox();
app.whenReady().then(() => { const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false } }); const prefs = win.webContents.getLastWebPreferences(); if (!prefs.sandbox || prefs.nodeIntegration) throw new Error('Secure preferences failed'); win.destroy(); app.quit(); });
