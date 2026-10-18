const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workforceDesktop', {
  login: (credentials) => ipcRenderer.invoke('desktop:login', credentials),
  currentUser: () => ipcRenderer.invoke('desktop:current-user'),
  dashboard: () => ipcRenderer.invoke('desktop:dashboard'),
  saveConsent: (enabled) => ipcRenderer.invoke('desktop:save-consent', enabled),
  uploadCamera: (imageBytes) => ipcRenderer.invoke('desktop:upload-camera', imageBytes),
  logout: () => ipcRenderer.invoke('desktop:logout'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('desktop:start-with-windows', enabled),
  getStartWithWindows: () => ipcRenderer.invoke('desktop:get-start-with-windows'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:status', listener);
    return () => ipcRenderer.removeListener('desktop:status', listener);
  },
  onSessionEnded: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('desktop:session-ended', listener);
    return () => ipcRenderer.removeListener('desktop:session-ended', listener);
  }
});
