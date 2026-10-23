/**
 * main/index.js — OpenCodeLoop 桌面入口
 * 多任务守护管理：窗口 / 托盘 / 菜单 / IPC / DaemonManager
 */
import { app, shell, BrowserWindow, Menu, Tray, nativeImage, ipcMain, dialog, nativeTheme, screen } from 'electron'
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, accessSync, copyFileSync, constants } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { readOrphans, writeOrphans, reapOrphans, runningList } from './orphan.js'
import { ConfigStore, configPath } from './store.js'
import { Daemon } from './daemon.js'
import {
  resolveBinary,
  listSessions,
  checkAttach,
  readProjectConfig,
  writeProjectPermission,
  diagnoseBinary,
  detectRunFlags,
  listModels,
  exportSessionModel,
  listSessionsForProjects,
  apiHistorySessions,
  apiSessionsForDir,
  sessionModelById,
  deleteSession
} from './opencode.js'
import { detectEnvironment } from './envdetect.js'
import { restartAttach } from './attachctl.js'

const APP_ICON = join(__dirname, '../../resources/icon.png')
const TRAY_ICON = join(__dirname, '../../resources/tray.png')

let win = null
let tray = null
let store = null
let resolvedBin = null
/** 二进制解析的并发缓存：多任务同时启动只解析一次 */
let binPromise = null
let forceQuit = false

/** taskId → Daemon（惰性创建） */
const daemons = new Map()

// ---------- 便携模式：配置/日志保存在安装目录（exe 同级 data/，只读时回退 userData） ----------

const legacyUserData = app.getPath('userData')
const portableDataDir = (() => {
  try {
    const base = app.isPackaged ? dirname(app.getPath('exe')) : app.getAppPath()
    const dataDir = join(base, 'data')
    mkdirSync(dataDir, { recursive: true })
    accessSync(dataDir, constants.W_OK)
    return dataDir
  } catch {
    return null
  }
})()
if (portableDataDir) {
  // 一次性迁移旧 userData 里的配置（便携目录尚无配置时）
  try {
    const src = join(legacyUserData, 'config.json')
    const dst = join(portableDataDir, 'config.json')
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst)
  } catch {
    /* 迁移失败按全新配置处理 */
  }
  app.setPath('userData', portableDataDir)
}
const orphansFile = () => join(app.getPath('userData'), 'orphans.json')

/** 系统登录项：随开机自启动（隐藏窗口，仅托盘） */
function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: [], openAsHidden: true })
  } catch {
    /* 部分环境不支持 */
  }
}

const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

const taskById = (id) => store.all.tasks.find((t) => t.id === id)
const taskName = (id) => taskById(id)?.name || id

// ---------- 主进程错误日志（userData/logs/main-*.log，避免未捕获异常直接崩溃） ----------

function appendMainLog(line) {
  const d = new Date()
  const name = `main-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.log`
  const dir = join(app.getPath('userData'), 'logs')
  const text = `[${d.toISOString()}] ${line}\n`
  return appendFile(join(dir, name), text, 'utf-8').catch(() => {})
}

process.on('uncaughtException', (err) => {
  appendMainLog(`uncaughtException: ${err?.stack || err}`)
})
process.on('unhandledRejection', (reason) => {
  appendMainLog(`unhandledRejection: ${String(reason?.stack || reason)}`)
})

// ---------- 守护事件 → 渲染层（日志批量节流，事件带 taskId） ----------

let logBuf = []
let logTimer = null

function flushLogs() {
  logTimer = null
  if (logBuf.length) {
    send('daemon:log', logBuf)
    logBuf = []
  }
}

function onDaemonLog(taskId, entry) {
  logBuf.push({ ...entry, taskId, taskName: taskName(taskId) })
  if (logBuf.length >= 50) flushLogs()
  else if (!logTimer) logTimer = setTimeout(flushLogs, 300)
  updateTray()
}

function onDaemonState(taskId, state) {
  send('daemon:state', { taskId, state })
  // 孤儿看护快照：记录存活守护进程，异常退出后下次启动清理
  const snapshot = {}
  for (const [id, d] of daemons) snapshot[id] = d.state
  writeOrphans(orphansFile(), runningList(snapshot, taskName))
  updateTray()
  rebuildMenu()
}

function daemonFor(taskId) {
  let d = daemons.get(taskId)
  if (!d) {
    d = new Daemon({
      // 轮结束后探测会话实际使用的模型（API 优先，export 兜底）
      resolveModel: async (sessionId) => {
        const task = taskById(taskId)
        if (!task?.project) return ''
        await ensureBinary()
        return sessionModelById(sessionId, task.project, resolvedBin)
      }
    })
    d.on('log', (entry) => onDaemonLog(taskId, entry))
    d.on('state', (st) => onDaemonState(taskId, st))
    daemons.set(taskId, d)
  }
  return d
}

function ensureBinary() {
  if (!binPromise) {
    binPromise = resolveBinary(store.all.opencodePath)
      .then((b) => {
        resolvedBin = b
        return b
      })
      .catch((err) => {
        binPromise = null
        throw err
      })
  }
  return binPromise
}

async function startTask(taskId) {
  const task = taskById(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  await ensureBinary()
  const caps = await detectRunFlags(resolvedBin)
  const r = await daemonFor(task.id).start(task, resolvedBin, caps)
  if (!r.ok) send('daemon:error', { taskId, message: r.error })
  return r
}

function stopAll(reason = '已手动停止') {
  for (const d of daemons.values()) {
    if (d.busy) d.stop(reason)
  }
}

const daemonSummary = () => {
  let running = 0
  let waiting = 0
  let done = 0
  let error = 0
  for (const d of daemons.values()) {
    if (d.state.status === 'running') running++
    else if (d.state.status === 'waiting') waiting++
    else if (d.state.status === 'done') done++
    else if (d.state.status === 'error') error++
  }
  return { running, waiting, done, error, total: store.all.tasks.length }
}

// ---------- 托盘 ----------

function statusText() {
  const s = daemonSummary()
  if (!s.total) return '无任务'
  const parts = [`${s.total} 个任务`]
  if (s.running) parts.push(`运行 ${s.running}`)
  if (s.waiting) parts.push(`等待重启 ${s.waiting}`)
  if (s.done) parts.push(`完成 ${s.done}`)
  if (s.error) parts.push(`异常 ${s.error}`)
  if (!s.running && !s.waiting && !s.done && !s.error) parts.push('全部停止')
  return parts.join(' · ')
}

function updateTray() {
  if (!tray) return
  tray.setToolTip(`OpenCodeLoop — ${statusText()}`)
  const taskItems = store.all.tasks.map((t) => {
    const st = daemons.get(t.id)?.state.status || 'stopped'
    const stText = { running: '守护中', waiting: '等待重启', done: '已完成', error: '异常', stopped: '已停止' }[st]
    const busy = st === 'running' || st === 'waiting'
    return {
      label: `${t.name}（${stText}）`,
      submenu: [
        { label: '启动', enabled: !busy, click: () => startTask(t.id) },
        { label: '停止', enabled: busy, click: () => daemons.get(t.id)?.stop() },
        { label: '立即重启', enabled: busy, click: () => daemons.get(t.id)?.restartNow() }
      ]
    }
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusText(), enabled: false },
      { type: 'separator' },
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      ...taskItems,
      { type: 'separator' },
      {
        label: '全部启动',
        click: () => store.all.tasks.forEach((t) => startTask(t.id))
      },
      { label: '全部停止', enabled: daemons.size > 0, click: () => stopAll() },
      { type: 'separator' },
      {
        label: '退出（并停止全部守护）',
        click: () => {
          forceQuit = true
          stopAll()
          app.quit()
        }
      }
    ])
  )
}

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  updateTray()
  tray.on('click', () => showMainWindow())
}

// ---------- 菜单 ----------

function rebuildMenu() {
  const action = (name, payload) => () => send('menu:action', name, payload)
  const template = [
    {
      label: '守护',
      submenu: [
        { label: '全部启动', accelerator: 'CmdOrCtrl+Alt+S', click: () => store.all.tasks.forEach((t) => startTask(t.id)) },
        { label: '全部停止', accelerator: 'CmdOrCtrl+Alt+X', enabled: daemons.size > 0, click: () => stopAll() },
        { type: 'separator' },
        { label: '打开日志文件…', click: action('log:open') },
        { label: '在资源管理器中显示日志', click: action('log:reveal') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '任务', accelerator: 'CmdOrCtrl+1', click: action('view', 'dashboard') },
        { label: '会话', accelerator: 'CmdOrCtrl+2', click: action('view', 'sessions') },
        { label: '权限', accelerator: 'CmdOrCtrl+3', click: action('view', 'permissions') },
        { label: '提示词', accelerator: 'CmdOrCtrl+4', click: action('view', 'prompt') },
        { label: '设置', accelerator: 'CmdOrCtrl+5', click: action('view', 'settings') },
        { type: 'separator' },
        { label: '浅色主题', type: 'radio', checked: store.all.theme === 'light', click: action('theme', 'light') },
        { label: '深色主题', type: 'radio', checked: store.all.theme === 'dark', click: action('theme', 'dark') },
        { label: '跟随系统', type: 'radio', checked: store.all.theme === 'system', click: action('theme', 'system') },
        { type: 'separator' },
        // 打包版不暴露 DevTools（安全面收敛）
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: '开发者工具' }])
      ]
    },
    {
      label: '帮助',
      submenu: [{ label: '关于 OpenCodeLoop', click: action('about') }]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- 窗口 ----------

function createWindow() {
  // 恢复上次的窗口位置与尺寸（校验仍落在某块显示器内才应用）
  let bounds = {}
  const saved = store?.all?.windowBounds
  if (saved && saved.width && saved.height) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return saved.x + saved.width > a.x && saved.x < a.x + a.width && saved.y + saved.height > a.y && saved.y < a.y + a.height
    })
    if (visible) bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  }

  win = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 800,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 860,
    minHeight: 560,
    show: false,
    icon: existsSync(APP_ICON) ? APP_ICON : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f2430' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  let boundsTimer = null
  const saveBoundsSoon = () => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return
      store.update({ windowBounds: win.getBounds() }).catch(() => {})
    }, 600)
  }
  win.on('resize', saveBoundsSoon)
  win.on('move', saveBoundsSoon)

  win.on('ready-to-show', () => win.show())

  // 安全防护：禁止窗口劫持（新窗口/导航到任意 URL）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL'] || ''
    if ((devUrl && url.startsWith(devUrl)) || (url.startsWith('file://') && url.includes('index.html'))) return
    e.preventDefault()
  })

  // 渲染进程崩溃：自动恢复，避免白屏失控
  win.webContents.on('render-process-gone', (_e, details) => {
    appendMainLog(`renderer gone: ${details.reason} (exitCode=${details.exitCode})`)
    if (details.reason !== 'clean-exit') win.webContents.reload()
  })

  win.on('closed', () => {
    win = null
  })

  win.on('close', (e) => {
    store.update({ windowBounds: win.getBounds() }).catch(() => {})
    if (forceQuit) return
    const busy = [...daemons.values()].some((d) => d.busy)
    // 开启「关闭到托盘」：直接隐藏（无论守护是否运行）
    if (store.all.closeToTray) {
      e.preventDefault()
      win.hide()
      return
    }
    // 未开启托盘隐藏但守护在运行：询问处理方式
    if (busy) {
      e.preventDefault()
      dialog
        .showMessageBox(win, {
          type: 'question',
          title: '守护运行中',
          message: '仍有守护任务在运行，如何处理？',
          buttons: ['隐藏到托盘（继续守护）', '停止守护并退出', '取消'],
          defaultId: 0,
          cancelId: 2,
          noLink: true
        })
        .then(({ response }) => {
          if (response === 0) win.hide()
          else if (response === 1) {
            forceQuit = true
            stopAll()
            app.quit()
          }
        })
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    const u = new URL(process.env['ELECTRON_RENDERER_URL'])
    const viewArg = process.argv.find((a) => a.startsWith('--view='))
    if (viewArg) u.searchParams.set('view', viewArg.split('=')[1])
    win.loadURL(u.toString())
  } else {
    const viewArg = process.argv.find((a) => a.startsWith('--view='))
    win.loadFile(join(__dirname, '../renderer/index.html'), viewArg ? { query: { view: viewArg.split('=')[1] } } : undefined)
  }
}

function showMainWindow() {
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('config:get', () => store.all)

  ipcMain.handle('config:set', async (_e, partial) => {
    const removedIds = Array.isArray(partial?.tasks)
      ? daemons.keys().filter((id) => !partial.tasks.some((t) => t.id === id)).toArray()
      : []
    const next = await store.update(partial || {})
    // 已删除的任务：先停守护再移除实例，避免孤儿守护
    for (const id of removedIds) {
      daemons.get(id)?.stop('任务已删除，守护停止')
      daemons.delete(id)
    }
    if (partial && 'theme' in partial) nativeTheme.themeSource = next.theme
    if (partial && 'loginAtBoot' in partial) applyLoginItem(next.loginAtBoot)
    // opencode 路径变更：失效二进制缓存，下次启动重新解析
    if (partial && 'opencodePath' in partial) {
      binPromise = null
      resolvedBin = null
    }
    rebuildMenu()
    updateTray()
    return next
  })

  ipcMain.handle('daemon:start', (_e, taskId) => startTask(taskId))
  ipcMain.handle('daemon:stop', (_e, taskId) => {
    daemons.get(taskId)?.stop()
    return { ok: true }
  })
  ipcMain.handle('daemon:restart', (_e, taskId) => {
    daemons.get(taskId)?.restartNow()
    return { ok: true }
  })
  ipcMain.handle('daemon:snapshots', () =>
    [...daemons.entries()].map(([taskId, d]) => ({
      taskId,
      state: { ...d.state },
      lines: d.tail(200).map((l) => ({ ...l, taskId }))
    }))
  )

  // 参数为 taskId（已保存任务）或 { project }（对话框中未保存的任务草稿）；API 优先，CLI 兜底
  ipcMain.handle('opencode:sessions', async (_e, arg) => {
    let project = null
    if (typeof arg === 'string') project = taskById(arg)?.project || null
    else if (arg && typeof arg === 'object') project = String(arg.project || '')
    if (!project) return { ok: false, sessions: [], raw: '', error: '未指定项目目录' }
    const api = await apiSessionsForDir(project)
    if (api.ok) {
      return {
        ok: true,
        sessions: api.rows.map((s) => ({ id: s.id, title: s.title || '', updatedAt: s.updated || null, model: s.model || '' })),
        raw: '',
        error: '',
        source: 'api'
      }
    }
    await ensureBinary()
    const r = await listSessions(project, resolvedBin)
    return { ...r, source: 'cli' }
  })

  // arg: taskId 或 { url }（任务草稿）
  ipcMain.handle('opencode:attach-check', (_e, arg) => {
    let url = ''
    if (typeof arg === 'string') url = taskById(arg)?.attachUrl || ''
    else if (arg && typeof arg === 'object') url = String(arg.url || '')
    return checkAttach(url)
  })

  ipcMain.handle('attach:restart', async (_e, arg) => {
    let url = ''
    if (typeof arg === 'string') url = taskById(arg)?.attachUrl || ''
    else if (arg && typeof arg === 'object') url = String(arg.url || '')
    if (!url) return { ok: false, message: '该任务未配置 attach 服务地址' }
    await ensureBinary()
    return restartAttach({ url, bin: resolvedBin })
  })

  ipcMain.handle('opencode:perm-read', async (_e, taskId) => {
    const task = taskById(taskId)
    if (!task?.project) return { ok: false, error: '该任务未配置项目目录' }
    const cfg = await readProjectConfig(task.project)
    return { ok: !cfg.parseError, file: cfg.file, exists: cfg.exists, data: cfg.data ?? null, error: cfg.parseError ?? '' }
  })

  ipcMain.handle('opencode:perm-write', async (_e, taskId, permission) => {
    const task = taskById(taskId)
    if (!task?.project) return { ok: false, error: '该任务未配置项目目录' }
    try {
      const r = await writeProjectPermission(task.project, permission)
      return { ok: true, ...r }
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  // 历史会话：优先 API（全局真实标题），失败回退按任务项目 CLI 扫描
  ipcMain.handle('opencode:history-sessions', async () => {
    const api = await apiHistorySessions()
    if (api.ok) return { source: 'api', rows: api.rows, total: api.total, error: '' }
    await ensureBinary()
    const projects = store.all.tasks.map((t) => t.project)
    const cli = await listSessionsForProjects(projects, resolvedBin)
    const rows = []
    for (const g of cli.groups) {
      const projectName = String(g.project).split(/[\\/]/).filter(Boolean).pop() || ''
      for (const s of g.sessions) {
        rows.push({ id: s.id, title: s.title || '', dir: g.project, projectName, updated: s.updatedAt || null, model: '' })
      }
    }
    rows.sort((a, b) => (b.updated || 0) - (a.updated || 0))
    return { source: 'cli', rows, total: rows.length, error: api.error || '' }
  })

  // 删除会话：{ sessionId, project } 或 taskId（使用该任务的项目目录）
  ipcMain.handle('opencode:session-delete', async (_e, arg) => {
    let sessionId = ''
    let project = ''
    if (typeof arg === 'string') {
      const task = taskById(arg)
      sessionId = task?.sessionId || ''
      project = task?.project || ''
    } else if (arg && typeof arg === 'object') {
      sessionId = String(arg.sessionId || '')
      project = String(arg.project || '')
    }
    if (!sessionId) return { ok: false, error: '缺少会话 ID' }
    await ensureBinary()
    return deleteSession(project, resolvedBin, sessionId)
  })

  ipcMain.handle('opencode:models', async () => {
    await ensureBinary()
    return listModels(resolvedBin)
  })

  ipcMain.handle('opencode:diagnose', async () => diagnoseBinary(store.all.opencodePath))

  ipcMain.handle('env:detect', () => detectEnvironment(store.all.opencodePath))

  ipcMain.handle('app:datadir', () => ({
    dir: app.getPath('userData'),
    portable: Boolean(portableDataDir)
  }))

  ipcMain.handle('app:login-item', () => {
    try {
      return Boolean(app.getLoginItemSettings().openAtLogin)
    } catch {
      return false
    }
  })

  ipcMain.handle('app:set-login-item', (_e, v) => {
    applyLoginItem(!!v)
    try {
      return Boolean(app.getLoginItemSettings().openAtLogin)
    } catch {
      return false
    }
  })

  ipcMain.handle('dialog:pick-file', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件',
      properties: ['openFile'],
      defaultPath: defaultPath || undefined,
      filters: [
        { name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths.length) return { canceled: true }
    return { canceled: false, path: r.filePaths[0] }
  })

  ipcMain.handle('shell:reveal-path', (_e, p) => {
    if (typeof p === 'string' && p && existsSync(p)) {
      shell.showItemInFolder(p)
      return { ok: true }
    }
    return { ok: false, error: '路径不存在' }
  })

  ipcMain.handle('dialog:pick-folder', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(win, {
      title: '选择项目目录',
      properties: ['openDirectory'],
      defaultPath: defaultPath || undefined
    })
    if (r.canceled || !r.filePaths.length) return { canceled: true }
    return { canceled: false, path: r.filePaths[0] }
  })

  ipcMain.handle('log:open', async (_e, taskId) => {
    const task = taskById(taskId)
    const p = task?.logFile || join(task?.project || '', 'keep-alive.log')
    if (!p || !existsSync(p)) return { ok: false, error: '日志文件尚不存在' }
    const err = await shell.openPath(p)
    return { ok: !err, error: err }
  })

  ipcMain.handle('log:reveal', async (_e, taskId) => {
    const task = taskById(taskId)
    const p = task?.logFile || join(task?.project || '', 'keep-alive.log')
    if (!p || !existsSync(p)) return { ok: false, error: '日志文件尚不存在' }
    shell.showItemInFolder(p)
    return { ok: true }
  })

  ipcMain.on('app:quit', () => {
    forceQuit = true
    stopAll()
    app.quit()
  })
}

// ---------- 生命周期 ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.qiuyj.opencodeloop')
    store = new ConfigStore(configPath(app.getPath('userData')))
    await store.load()
    nativeTheme.themeSource = store.all.theme

    // 孤儿看护：上次异常退出残留的守护进程在此清理
    appendMainLog(`数据目录：${app.getPath('userData')}（${portableDataDir ? '便携模式' : '系统 userData'}）`)
    const reaped = await reapOrphans(orphansFile(), { onLog: (m) => appendMainLog(m) })
    if (reaped.length) appendMainLog(`孤儿清理完成，共 ${reaped.length} 个进程`)

    registerIpc()
    rebuildMenu()
    createWindow()
    createTray()

    // 恢复勾选了「自动运行」的任务
    for (const t of store.all.tasks.filter((t) => t.autoStart)) startTask(t.id)

    // 同步系统登录项（路径随版本更新变化，就绪时校正一次）
    if (store.all.loginAtBoot) applyLoginItem(true)

    // 预热：提前解析 opencode 路径与 run 能力，避免首次点击启动时等待 CLI 探测
    ensureBinary()
      .then((b) => (b ? detectRunFlags(b) : null))
      .catch(() => {})

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    forceQuit = true
    stopAll('应用退出，守护停止')
    try {
      tray?.destroy()
    } catch {
      /* ignore */
    }
    tray = null
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
