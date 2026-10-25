/** preload 桥接的薄封装：集中判空，方便在 Web 预览时降级 */
const bridge = () => window.opencodeloop

export const api = {
  get available() {
    return !!bridge()
  },
  getConfig: () => bridge()?.getConfig(),
  setConfig: (partial) => bridge()?.setConfig(partial),
  daemonStart: (taskId) => bridge()?.daemonStart(taskId),
  daemonStop: (taskId) => bridge()?.daemonStop(taskId),
  daemonRestart: (taskId) => bridge()?.daemonRestart(taskId),
  daemonSnapshots: () => bridge()?.daemonSnapshots(),
  /** arg: taskId（已保存任务）或 { project }（未保存草稿） */
  listSessions: (arg) => bridge()?.listSessions(arg),
  historySessions: () => bridge()?.historySessions(),
  deleteSession: (arg) => bridge()?.deleteSession(arg),
  listModels: () => bridge()?.listModels(),
  checkAttach: (arg) => bridge()?.checkAttach(arg),
  attachRestart: (arg) => bridge()?.attachRestart(arg),
  readPermissions: (taskId) => bridge()?.readPermissions(taskId),
  writePermissions: (taskId, p) => bridge()?.writePermissions(taskId, p),
  diagnoseBinary: () => bridge()?.diagnoseBinary(),
  envDetect: () => bridge()?.envDetect(),
  dataDir: () => bridge()?.dataDir(),
  getLoginItem: () => bridge()?.getLoginItem(),
  setLoginItem: (v) => bridge()?.setLoginItem(v),
  pickFile: (d) => bridge()?.pickFile(d),
  pickFolder: (d) => bridge()?.pickFolder(d),
  revealPath: (p) => bridge()?.revealPath(p),
  openLogFile: (taskId) => bridge()?.openLogFile(taskId),
  revealLogFile: (taskId) => bridge()?.revealLogFile(taskId),
  updateCheck: () => bridge()?.updateCheck(),
  openExternal: (url) => bridge()?.openExternal(url),
  onDaemonState: (cb) => bridge()?.onDaemonState(cb) || (() => {}),
  onDaemonLog: (cb) => bridge()?.onDaemonLog(cb) || (() => {}),
  onDaemonError: (cb) => bridge()?.onDaemonError(cb) || (() => {}),
  onUpdateAvailable: (cb) => bridge()?.onUpdateAvailable(cb) || (() => {}),
  onMenuAction: (cb) => bridge()?.onMenuAction(cb) || (() => {})
}
