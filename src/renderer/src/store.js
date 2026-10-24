/** 渲染层全局状态：任务列表 / 多守护状态 / 会话 / attach 健康 / 活动日志 */
import { reactive, computed } from 'vue'
import { useActivityLog } from '@ux/composables'
import { api } from './api'

export const store = reactive({
  ready: false,
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

let saveTimers = new Map()
/** 防抖保存任务（输入框逐键触发的场景） */
export function saveTaskDebounced(task, delay = 600) {
  clearTimeout(saveTimers.get(task.id))
  saveTimers.set(
    task.id,
    setTimeout(() => {
      saveTimers.delete(task.id)
      saveTask(task)
    }, delay)
  )
}

export async function removeTask(taskId) {
  const list = plain(tasks.value.filter((t) => t.id !== taskId))
  store.config.tasks = list
  if (store.selectedTaskId === taskId) store.selectedTaskId = list[0]?.id || ''
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

export async function init() {
  if (store.ready) return
  store.config = await api.getConfig()
  store.selectedTaskId = store.config.tasks[0]?.id || ''

  const snaps = (await api.daemonSnapshots()) || []
  for (const s of snaps) {
    store.daemons[s.taskId] = s.state
    for (const e of s.lines || []) {
      // 附带 taskId：日志面板按任务/项目过滤依赖该字段
      const entry = log.push(e.level, `[${taskNameOf(s.taskId)}] ${e.title}`, e.detail)
      entry.taskId = s.taskId
    }
  }

  api.onDaemonState(({ taskId, state }) => {
    store.daemons[taskId] = state
  })
  offLog?.()
  offLog = api.onDaemonLog((entries) => {
    for (const e of entries || []) log.push(e.level, `[${e.taskName || taskNameOf(e.taskId)}] ${e.title}`, e.detail)
  })
  api.onDaemonError(({ message }) => log.push('error', String(message)))

  // 守护事件会覆盖注入，这里不 ready 会导致视图空白
  store.ready = true
}

function taskNameOf(taskId) {
  return store.config?.tasks?.find((t) => t.id === taskId)?.name || taskId
}

export async function refreshSessions() {
  if (!currentTask.value) {
    store.sessions = { loading: false, items: [], raw: '', error: '尚无任务' }
    return
  }
  store.sessions.loading = true
  try {
    const r = await api.listSessions(currentTask.value.id)
    store.sessions.items = r?.sessions || []
    store.sessions.raw = r?.raw || ''
    store.sessions.error = r?.error || ''
  } finally {
    store.sessions.loading = false
  }
}

export async function refreshAttach() {
  if (!currentTask.value) return
  const r = await api.checkAttach(currentTask.value.id)
  if (!r) return
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

// 本地桌面工具：暴露调试句柄（诊断/自动化验证用；IPC 事件会覆盖手动改动）
if (typeof window !== 'undefined') window.__store = store
