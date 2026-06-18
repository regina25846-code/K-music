const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  savePlaylists: (pl) => ipcRenderer.invoke('save-playlists', pl),
  getStream: (ytUrl, quality) => ipcRenderer.invoke('get-stream', ytUrl, quality),
  search: (query) => ipcRenderer.invoke('search', query),
  getVideoInfo: (ytUrl) => ipcRenderer.invoke('get-video-info', ytUrl),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  closeSettings: () => ipcRenderer.invoke('close-settings'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  setAlwaysOnTop: (val) => ipcRenderer.invoke('set-always-on-top', val),
  getLoginItem: () => ipcRenderer.invoke('get-login-item'),
  setLoginItem: (val) => ipcRenderer.invoke('set-login-item', val),
  minimize: () => ipcRenderer.invoke('minimize'),
  closeApp: () => ipcRenderer.invoke('close-app'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  checkYtdlp: () => ipcRenderer.invoke('check-ytdlp'),
  onSettingsClosed: (cb) => ipcRenderer.on('settings-closed', cb),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', cb),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', cb),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', cb),
  onOpenAbout: (cb) => ipcRenderer.on('open-about', cb)
});
