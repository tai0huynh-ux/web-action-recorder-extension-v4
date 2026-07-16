const { contextBridge, ipcRenderer } = require('electron');
const call = (channel) => () => ipcRenderer.invoke(channel);
const api = Object.freeze({ apiVersion: 'v1', system: Object.freeze({ getBootstrapState: call('war:system:bootstrap'), getRuntimeStatus: call('war:system:runtime') }) });
contextBridge.exposeInMainWorld('warController', api);
