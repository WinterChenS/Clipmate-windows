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
  onHistoryUpdated: (callback) => {
    ipcRenderer.on('history-updated', (_, data) => callback(data))
  },
  onWindowShown: (callback) => {
    ipcRenderer.on('window-shown', (_, data) => callback(data))
  }
})
