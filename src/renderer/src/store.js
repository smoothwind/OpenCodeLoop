/** 渲染层全局状态：任务列表 / 多守护状态 / 会话 / attach 健康 / 活动日志 */
import { reactive, computed } from 'vue'
import { useActivityLog } from '@ux/composables'
import { api } from './api'

export const store = reactive({
  ready: false,
  /** 初始化失败原因（非空时界面提供重试入口） */
  initError: '',
  config: null,
  /** 当前操作聚焦的任务 id（会话/权限/提示词页绑定它） */
  selectedTaskId: '',
  /** 日志面板按任务过滤（'' = 全部任务） */
  logFilterTaskId: '',
  /** taskId → 守护状态快照 */
  daemons: {},
  sessions: { loading: false, items: [], raw: '', error: '' },
  attach: { state: 'unknown', status: null, ms: null, message: '' },
  view: 'dashboard',
  /** 各视图的日志面板显隐（null = 未手动覆盖） */
  logsOverride: {},
  /** 更新检测结果（status: available|latest|none|error） */
  update: { checking: false, result: null },
  splitRatio: 0.62,
  binary: null
})

/** 各视图默认是否展示日志面板：仅任务页默认开启（监控主场景） */
export const LOGS_DEFAULT = {
  dashboard: true,
  sessions: false,
  permissions: false,
  prompt: false,
  settings: false
}

/** 当前视图日志面板是否可见：手动覆盖 > 视图默认 */
export function logsVisible(view = store.view) {
  const o = store.logsOverride[view]
  return o === undefined ? LOGS_DEFAULT[view] ?? false : o
}

/** 手动切换当前视图的日志面板（覆盖默认值） */
export function toggleLogs() {
  store.logsOverride[store.view] = !logsVisible()
}

export const log = useActivityLog({ limit: 800 })

/** 写日志并标记所属任务（日志面板按任务过滤依赖 taskId；useActivityLog.push 返回的就是缓冲区内的条目） */
function pushLog(level, title, detail, taskId) {
  const entry = log.push(level, title, detail)
  if (taskId) entry.taskId = taskId
  return entry
}

export const tasks = computed(() => store.config?.tasks || [])

export const currentTask = computed(
  () => tasks.value.find((t) => t.id === store.selectedTaskId) || tasks.value[0] || null
)

export function selectTask(id) {
  if (tasks.value.some((t) => t.id === id)) store.selectedTaskId = id
}

/** 倒计时人性化：45 秒 / 4 分 20 秒 / 3 小时 12 分 */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

export function daemonState(taskId) {
  return (
    store.daemons[taskId] || {
      status: 'stopped',
      runs: 0,
      startedAt: null,
      roundStartedAt: null,
      lastExitCode: null,
      doneAt: null,
      nextRestartAt: null,
      lastError: '',
      waitReason: '',
      errorKind: '',
      sessionWaitStartedAt: null,
      pid: null,
      model: '',
      actualModel: '',
      sessionId: ''
    }
  )
}

/** 深拷贝为纯对象：剥掉 Vue 响应式 Proxy，否则跨 contextBridge 结构化克隆会失败 */
const plain = (o) => JSON.parse(JSON.stringify(o))

export function setConfig(partial) {
  // 配置未加载完成（初始化失败期间）时拒绝写入，避免对 null 赋值崩溃
  if (!store.config) return Promise.resolve(null)
  const p = partial || {}
  // UI 侧保留响应式引用即时更新；IPC 侧统一深拷贝（tasks/promptPresets 等数组元素可能是代理）
  Object.assign(store.config, p)
  return api.setConfig(plain(p))
}

/** 保存单个任务（按 id upsert 到 config.tasks） */
export async function saveTask(task) {
  const list = plain(tasks.value.map((t) => (t.id === task.id ? { ...task } : t)))
  if (!list.some((t) => t.id === task.id)) list.push(plain(task))
  store.config.tasks = list
  await api.setConfig({ tasks: list })
  return task
}

const saveTimers = new Map()
/**
 * 防抖保存任务（输入框逐键触发的场景）。
 * 调度时记录基准快照，触发时只回放「相对基准变化了的字段」并合并到当前最新状态：
 * 防抖窗口内其他路径（如另一页的立即保存）新写入的字段不会被旧快照回滚。
 */
export function saveTaskDebounced(task, delay = 600) {
  const base = tasks.value.find((t) => t.id === task.id)
  const pending = { task: plain(task), base: base ? plain(base) : null }
  clearTimeout(saveTimers.get(task.id))
  saveTimers.set(
    task.id,
    setTimeout(() => {
      saveTimers.delete(task.id)
      // 任务已被删除：丢弃待保存快照（防「已删任务复活」）
      const latest = tasks.value.find((t) => t.id === task.id)
      if (!latest) return
      const patch = {}
      for (const [k, v] of Object.entries(pending.task)) {
        if (!pending.base || JSON.stringify(v) !== JSON.stringify(pending.base[k])) patch[k] = v
      }
      saveTask({ ...latest, ...patch })
    }, delay)
  )
}

export async function removeTask(taskId) {
  // 取消该任务的待保存定时器：否则 600ms 内「先编辑后删除」会把已删任务写回 config
  clearTimeout(saveTimers.get(taskId))
  saveTimers.delete(taskId)
  const list = plain(tasks.value.filter((t) => t.id !== taskId))
  store.config.tasks = list
  if (store.selectedTaskId === taskId) store.selectedTaskId = list[0]?.id || ''
  // 被删任务若仍在日志过滤条件里，面板会永远空白：回退到全部任务
  if (store.logFilterTaskId === taskId) store.logFilterTaskId = ''
  await api.setConfig({ tasks: list })
}

/** 启动中集合（taskId）：按钮加载态 / 失败提示 */
export const startingIds = reactive(new Set())

/** 启动任务守护：带加载态与失败通知的统一入口 */
export async function startTaskDaemon(taskId) {
  if (startingIds.has(taskId)) return { ok: false, error: '' }
  startingIds.add(taskId)
  try {
    const r = await api.daemonStart(taskId)
    return r || { ok: false, error: '无响应' }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  } finally {
    startingIds.delete(taskId)
  }
}

let offLog = null
let offState = null
let offErr = null
let offUpdate = null

/** 解绑守护/更新推送（窗口卸载时调用；init 重复执行前也会先调用，防监听器累积） */
export function disposeListeners() {
  offLog?.()
  offLog = null
  offState?.()
  offState = null
  offErr?.()
  offErr = null
  offUpdate?.()
  offUpdate = null
}

/** 手动/自动检查更新（只提醒，不下载）；结果写入 store.update 并返回 */
export async function checkUpdate() {
  if (store.update.checking) return store.update.result
  store.update.checking = true
  try {
    const r = await api.updateCheck()
    store.update.result = r || { status: 'error', error: '无响应' }
    return store.update.result
  } catch (err) {
    // IPC 失败不向上抛：调用方（菜单/设置页）只负责渲染结果分支
    store.update.result = { status: 'error', error: String(err?.message || err) }
    return store.update.result
  } finally {
    store.update.checking = false
  }
}

export async function init() {
  if (store.ready) return
  // 先注册推送订阅（注册动作本身不依赖配置加载成败；HMR 重复 init 前先解绑旧订阅）
  disposeListeners()
  offState = api.onDaemonState(({ taskId, state }) => {
    store.daemons[taskId] = state
  })
  offLog = api.onDaemonLog((entries) => {
    for (const e of entries || []) {
      pushLog(e.level, `[${e.taskName || taskNameOf(e.taskId)}] ${e.title}`, e.detail, e.taskId)
    }
  })
  offErr = api.onDaemonError(({ taskId, message }) => pushLog('error', String(message), undefined, taskId))
  // 主进程启动自检发现新版本时推送（App 层负责提示）
  offUpdate = api.onUpdateAvailable((info) => {
    if (info) store.update.result = info
  })

  // 配置/快照加载失败不静默卡死：记录原因供界面展示重试入口
  try {
    store.config = await api.getConfig()
    store.selectedTaskId = store.config.tasks[0]?.id || ''

    const snaps = (await api.daemonSnapshots()) || []
    for (const s of snaps) {
      store.daemons[s.taskId] = s.state
      for (const e of s.lines || []) {
        // 附带 taskId：日志面板按任务/项目过滤依赖该字段
        pushLog(e.level, `[${taskNameOf(s.taskId)}] ${e.title}`, e.detail, s.taskId)
      }
    }
  } catch (err) {
    store.initError = String(err?.message || err)
    pushLog('error', `初始化失败：${store.initError}`)
    return
  }

  // 守护事件会覆盖注入，这里不 ready 会导致视图空白
  store.ready = true
}

function taskNameOf(taskId) {
  return store.config?.tasks?.find((t) => t.id === taskId)?.name || taskId
}

let sessionsSeq = 0

export async function refreshSessions() {
  if (!currentTask.value) {
    store.sessions = { loading: false, items: [], raw: '', error: '尚无任务' }
    return
  }
  const seq = ++sessionsSeq
  store.sessions.loading = true
  try {
    const r = await api.listSessions(currentTask.value.id)
    // 响应乱序保护：仅接受最后一次请求的结果（快速切换任务时旧响应会晚到）
    if (seq !== sessionsSeq) return
    store.sessions.items = r?.sessions || []
    store.sessions.raw = r?.raw || ''
    store.sessions.error = r?.error || ''
  } catch (err) {
    if (seq === sessionsSeq) store.sessions.error = String(err?.message || err)
  } finally {
    if (seq === sessionsSeq) store.sessions.loading = false
  }
}

let attachSeq = 0

export async function refreshAttach() {
  if (!currentTask.value) return
  const seq = ++attachSeq
  const r = await api.checkAttach(currentTask.value.id).catch(() => null)
  if (!r || seq !== attachSeq) return
  store.attach.state = r.ok ? 'up' : 'down'
  store.attach.status = r.status ?? null
  store.attach.ms = r.ms ?? null
  store.attach.message = r.message || ''
}

export const STATUS_META = {
  stopped: { text: '已停止', tone: 'neutral', dot: false },
  running: { text: '守护中', tone: 'success', dot: true },
  waiting: { text: '等待重启', tone: 'warning', dot: true },
  done: { text: '已完成', tone: 'success', dot: false },
  error: { text: '异常停止', tone: 'danger', dot: false }
}

export const VIEW_TITLES = {
  dashboard: '任务',
  sessions: '会话',
  permissions: '权限',
  prompt: '提示词',
  settings: '设置'
}

// 本地桌面工具：暴露调试句柄（诊断/自动化验证用；仅开发构建，IPC 事件会覆盖手动改动）
if (import.meta.env.DEV && typeof window !== 'undefined') window.__store = store
