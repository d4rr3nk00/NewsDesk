const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('desk', {
  settings: () => ipcRenderer.invoke('settings'),
  local: () => ipcRenderer.invoke('open-local'),
  cloud: url => ipcRenderer.invoke('open-cloud', url),
  credentials: value => ipcRenderer.invoke('credentials', value)
});
