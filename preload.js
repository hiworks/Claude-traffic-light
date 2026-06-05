const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__claudeLight', {
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, data) => callback(data));
  },
  getInitialStatus: () => ipcRenderer.invoke('get-initial-status'),
  setOpacity: (value) => ipcRenderer.send('set-opacity', value),
  toggleAlwaysOnTop: () => ipcRenderer.send('toggle-always-on-top'),
  switchSession: (sessionId) => ipcRenderer.send('switch-session', sessionId),
  getWindowState: () => ipcRenderer.invoke('get-window-state'),
  toggleSize: () => ipcRenderer.send('toggle-size'),
  snapToClaude: () => ipcRenderer.send('snap-to-claude'),
  onSizeChanged: (callback) => {
    ipcRenderer.on('size-changed', (_event, mode) => callback(mode));
  },
  onScaleChanged: (callback) => {
    ipcRenderer.on('scale-changed', (_event, scale) => callback(scale));
  },
  setScale: (scale) => ipcRenderer.send('set-scale', scale),
  showTooltip: (text, x, y) => ipcRenderer.send('show-tooltip', { text, x, y }),
  hideTooltip: () => ipcRenderer.send('hide-tooltip'),
});
