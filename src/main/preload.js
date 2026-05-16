const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clipboardAPI', {
  getHistory: () => ipcRenderer.invoke('get-history'),
  getItemContent: (itemId) => ipcRenderer.invoke('get-item-content', itemId),
  getImageUrl: (itemId) => ipcRenderer.invoke('get-image-url', itemId),
  pasteItem: (item) => ipcRenderer.invoke('paste-item', item),
  copyItem: (item) => ipcRenderer.invoke('copy-item', item),
  pinItem: (itemId) => ipcRenderer.invoke('pin-item', itemId),
  deleteItem: (itemId) => ipcRenderer.invoke('delete-item', itemId),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  // 版本检查
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  skipUpdateVersion: (version) => ipcRenderer.invoke('skip-update-version', version),
  onUpdateCheckResult: (callback) => {
    ipcRenderer.removeAllListeners('update-check-result')
    ipcRenderer.on('update-check-result', (_, data) => callback(data))
  },
  onHistoryUpdated: (callback) => {
    ipcRenderer.removeAllListeners('history-updated')
    ipcRenderer.on('history-updated', (_, data) => callback(data))
  },
  onWindowShown: (callback) => {
    ipcRenderer.removeAllListeners('window-shown')
    ipcRenderer.on('window-shown', (_, data) => callback(data))
  }
})
