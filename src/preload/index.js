import { contextBridge, ipcRenderer } from 'electron'

const subscribe = (channel) => (callback) => {
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('opencodeloop', {
  runtime: 'electron',
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),

  daemonStart: (taskId) => ipcRenderer.invoke('daemon:start', taskId),
  daemonStop: (taskId) => ipcRenderer.invoke('daemon:stop', taskId),
  daemonRestart: (taskId) => ipcRenderer.invoke('daemon:restart', taskId),
  daemonSkipWait: (taskId) => ipcRenderer.invoke('daemon:skip-wait', taskId),
  daemonInterruptSession: (taskId) => ipcRenderer.invoke('daemon:interrupt-session', taskId),
  daemonSnapshots: () => ipcRenderer.invoke('daemon:snapshots'),

  listSessions: (arg) => ipcRenderer.invoke('opencode:sessions', arg),
  historySessions: () => ipcRenderer.invoke('opencode:history-sessions'),
  deleteSession: (arg) => ipcRenderer.invoke('opencode:session-delete', arg),
  listModels: () => ipcRenderer.invoke('opencode:models'),
  checkAttach: (arg) => ipcRenderer.invoke('opencode:attach-check', arg),
  attachRestart: (arg) => ipcRenderer.invoke('attach:restart', arg),
  readPermissions: (taskId) => ipcRenderer.invoke('opencode:perm-read', taskId),
  writePermissions: (taskId, permission) => ipcRenderer.invoke('opencode:perm-write', taskId, permission),
  diagnoseBinary: () => ipcRenderer.invoke('opencode:diagnose'),
  envDetect: () => ipcRenderer.invoke('env:detect'),
  dataDir: () => ipcRenderer.invoke('app:datadir'),
  getLoginItem: () => ipcRenderer.invoke('app:login-item'),
  setLoginItem: (v) => ipcRenderer.invoke('app:set-login-item', v),
  pickFile: (defaultPath) => ipcRenderer.invoke('dialog:pick-file', defaultPath),
  revealPath: (p) => ipcRenderer.invoke('shell:reveal-path', p),

  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
  openLogFile: (taskId) => ipcRenderer.invoke('log:open', taskId),
  revealLogFile: (taskId) => ipcRenderer.invoke('log:reveal', taskId),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  quitApp: () => ipcRenderer.send('app:quit'),

  onDaemonState: subscribe('daemon:state'),
  onDaemonLog: subscribe('daemon:log'),
  onDaemonError: subscribe('daemon:error'),
  onUpdateAvailable: subscribe('update:available'),
  onMenuAction: subscribe('menu:action')
})
