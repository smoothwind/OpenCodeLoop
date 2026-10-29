/**
 * daemon.js — 无人值守守护引擎（keep-alive.ps1 的进程化实现）
 *
 * 状态机：stopped → running ⇄ waiting → done | stopped | error
 * - 每轮 spawn opencode run --format json [--auto] [--attach URL] [-s id | -c] "<prompt>"
 * - 退出即按 retryDelay 重启；输出出现完成标记（默认 DONE）则停止
 * - 全量输出落盘日志文件；内存环形缓冲经事件回调上报（UI 日志面板）
 *
 * 错误分级处理（errpolicy.js）：对每轮累计的错误文本做分类——
 * - 额度不足：无备选模型 → 等恢复时间到达自动拉起（不消耗重启次数）；
 *             有备选模型 → 切换备选模型按常规间隔重试
 * - 鉴权失败：有备选则切换，无备选则停止（同配置重试无意义）
 * - 限流：至少退避 60s；限流/网络/服务端/未知：按常规间隔重启
 *
 * 本模块不依赖 electron（回调上报），便于单元测试。
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import { classifyError, planRecovery, cooldownUntil, KIND_TEXT, LIMIT_TEXT, formatClock, formatWait, MODEL_PROBE_MS } from './errpolicy.js'
import { waitLimitMs, timeoutAction, sessionBusy, busyReason, outcomeText } from './sessiongate.js'

/** 日志文件缓冲写入流：集中管理打开/写/关，替代逐块 appendFile */
export class LogFileWriter {
  constructor() {
    this.stream = null
    this.file = ''
  }

  open(file) {
    if (this.file === file && this.stream) return
    this.close()
    try {
      this.stream = createWriteStream(file, { flags: 'a', encoding: 'utf-8' })
      this.file = file
      this.stream.on('error', () => {
        this.stream = null
      })
    } catch {
      this.stream = null
    }
  }

  write(text) {
    if (this.stream && text) this.stream.write(text)
  }

  close() {
    if (this.stream) {
      const s = this.stream
      this.stream = null
      this.file = ''
      try {
        s.end()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 模型链：主力在前，可选模型按序跟随（去重去空）。
 * 选择策略（见 selectModel）：主力优先；失败进入冷却后按链顺序降级到未受限的备选，
 * 冷却到期（额度/限流解封）后自动切回主力。
 */
export function effectiveModels(cfg) {
  const list = [cfg?.model, ...(cfg?.fallbackModels || [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  return [...new Set(list)]
}

/**
 * 本轮模型选择。
 * cooldowns：模型 → 不可用截止时间（epoch ms，额度/限流/鉴权失败时写入）。
 * preferIndex：优先尝试的链位置（连续失败顺延）；该模型受限时回到链首寻找可用模型。
 * - 主力未受限时永远优先主力（自动切回主力的核心规则）
 * - 首选受限 → 链首起找第一个未受限的模型
 * - 全部受限时返回最早解封的一个：提前试探，避免整条模型链停摆
 * 返回值 { model, index, blockedUntil }，blockedUntil 非空表示本次选中的模型仍在冷却。
 */
export function selectModel(cfg, cooldowns = new Map(), now = Date.now(), preferIndex = 0) {
  const models = effectiveModels(cfg)
  if (!models.length) return { model: '', index: -1, blockedUntil: null }
  const untilOf = (m) => {
    const v = cooldowns instanceof Map ? cooldowns.get(m) : cooldowns?.[m]
    const n = Number(v) || 0
    return n > now ? n : 0
  }
  const start = Math.min(Math.max(Number(preferIndex) || 0, 0), models.length - 1)
  if (!untilOf(models[start])) return { model: models[start], index: start, blockedUntil: null }
  for (let i = 0; i < models.length; i++) {
    if (i !== start && !untilOf(models[i])) return { model: models[i], index: i, blockedUntil: null }
  }
  let best = 0
  for (let i = 1; i < models.length; i++) {
    if (untilOf(models[i]) < untilOf(models[best])) best = i
  }
  return { model: models[best], index: best, blockedUntil: untilOf(models[best]) }
}

/**
 * 组装 opencode run 参数（与 keep-alive.ps1 的参数序列一致）。
 * caps.attach 为 false 时不传 --attach：部分 opencode 版本的 run 子命令已移除该 flag。
 */
export function buildRunArgs(cfg, caps = {}, model = '') {
  const args = ['run', '--format', 'json']
  if (cfg.autoApprove) args.push('--auto')
  if (cfg.attachUrl && caps.attach) args.push('--attach', cfg.attachUrl)
  if (model) args.push('-m', model)
  if (cfg.sessionMode === 'id' && cfg.sessionId) args.push('-s', cfg.sessionId)
  else if (cfg.sessionMode === 'id' || cfg.sessionMode === 'last') args.push('-c')
  return args
}

/** 提示词变量替换：{{project}} {{date}} {{time}} */
export function expandPrompt(text, ctx = {}) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const map = {
    project: ctx.project || '',
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in map ? map[k] : m))
}

/** 完成标记检测：与 ps1 的 -match "DONE" 语义一致（子串包含） */
export function isDone(text, keyword = 'DONE') {
  if (!keyword) return false
  return String(text || '').includes(keyword)
}

/**
 * 供应商错误体解析：response.body 可能是 JSON 字符串（业务错误再包一层），
 * 也可能是普通文本。统一返回对象形态 { message? , error? , code? , status? }。
 */
function parseErrorBody(body) {
  if (!body) return null
  if (typeof body === 'object') return body
  const s = String(body).trim()
  if (!s) return null
  if (!s.startsWith('{') && !s.startsWith('[')) return { message: s }
  try {
    const o = JSON.parse(s)
    return o && typeof o === 'object' ? o : { message: s }
  } catch {
    return { message: s }
  }
}

/** 首个非空字符串候选：错误文案可能散落在 error.message / error.data.message / response.body 中 */
function firstText(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

/**
 * 解析 opencode run --format json 的事件行 → 语义化交互条目（纯函数，可单测）。
 * 识别：AI 文本 / 工具调用 / 错误；返回对象带 sessionId（事件流中捕获实际会话）。
 * step-start、reasoning 等内部事件返回 { skip: true, sessionId }（不展示但用于会话检测）。
 */
export function parseRunEvent(line) {
  const t = String(line || '').trim()
  if (!t.startsWith('{')) return null
  let e
  try {
    e = JSON.parse(t)
  } catch {
    return null
  }
  if (!e || typeof e !== 'object') return null
  const part = e.part && typeof e.part === 'object' ? e.part : {}
  const sessionId = typeof e.sessionID === 'string' ? e.sessionID : ''
  switch (e.type) {
    case 'text': {
      const text = String(part.text || '').replace(/\s+/g, ' ').trim()
      if (!text) return { skip: true, sessionId }
      return {
        level: 'info',
        title: `[AI] ${text.slice(0, 180)}`,
        detail: String(part.text).slice(0, 4000),
        sessionId
      }
    }
    case 'tool': {
      const name = String(part.tool || part.state?.title || '未知工具').slice(0, 60)
      const st = part.state?.status ? ` · ${part.state.status}` : ''
      const input = part.state?.input ? JSON.stringify(part.state.input).slice(0, 2000) : ''
      // 工具失败（state.status === 'error'）：error 级展示并纳入错误分类
      const toolErr = part.state?.error ? String(part.state.error) : ''
      if (part.state?.status === 'error' && toolErr) {
        return {
          level: 'error',
          title: `[工具] ${name} · 失败：${toolErr.slice(0, 160)}`,
          detail: input || toolErr.slice(0, 4000),
          sessionId,
          errorText: toolErr.slice(0, 2000)
        }
      }
      return { level: 'info', title: `[工具] ${name}${st}`, detail: input || undefined, sessionId }
    }
    case 'error': {
      // opencode run --format json 的错误事件（两种形态）：
      // 1) { type:'error', error:{ name, data:{ message, statusCode } } }
      // 2) { type:'error', error:{ type:'provider.rate-limit', message, status, response:{ body } } }
      // 供应商常把真正的业务错误（如 GLM 1308）再编码进 response.body 字符串，需要解开才能读出文案/业务码
      const err = e.error && typeof e.error === 'object' ? e.error : {}
      const data = err.data && typeof err.data === 'object' ? err.data : {}
      const body = parseErrorBody(err.response?.body ?? e.response?.body)
      const bodyErr = body?.error && typeof body.error === 'object' ? body.error : body || {}
      const msg =
        firstText(
          err.message,
          data.message,
          bodyErr.message,
          body?.message,
          e.message,
          part.message,
          typeof e.error === 'string' ? e.error : '',
          err.name,
          part.error
        ) || '未知错误'
      // HTTP 状态与供应商业务码（如 1308）分开：业务码不能当 HTTP 状态展示
      const httpStatus =
        Number(
          err.status ||
            err.statusCode ||
            data.statusCode ||
            bodyErr.status ||
            body?.status ||
            e.statusCode
        ) || 0
      const bizCode = firstText(
        bodyErr.code != null ? String(bodyErr.code) : '',
        err.code != null ? String(err.code) : ''
      )
      const tags = [httpStatus ? `HTTP ${httpStatus}` : '', bizCode ? `错误码 ${bizCode}` : ''].filter(Boolean)
      return {
        level: 'error',
        title: `[错误] ${msg.slice(0, 180)}${tags.length ? `（${tags.join('，')}）` : ''}`,
        detail: t.slice(0, 4000),
        sessionId,
        // 原始事件全文纳入分类：业务码（1308）、HTTP 状态、type（provider.rate-limit）与恢复时间都在其中
        errorText: t.slice(0, 4000)
      }
    }
    default:
      return { skip: true, sessionId }
  }
}

const DONE_BUF_CAP = 400 * 1024

function ts(t = Date.now()) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function initialState() {
  return {
    status: 'stopped', // stopped | running | waiting | done | error
    runs: 0,
    startedAt: null,
    roundStartedAt: null,
    lastExitCode: null,
    doneAt: null,
    nextRestartAt: null,
    lastError: '',
    /** 等待原因（错误策略：额度恢复/限流退避等，供 UI 展示） */
    waitReason: '',
    /** 本轮错误分类（quota/auth/ratelimit/server/network/unknown） */
    errorKind: '',
    /** 等待目标会话空闲的起始时间（epoch ms；null = 未处于会话等待） */
    sessionWaitStartedAt: null,
    pid: null,
    /** 本轮实际使用的模型（配置解析值，轮启动设置） */
    model: '',
    /** 模型切换说明（主力受限/恢复时写入，供界面展示） */
    modelNote: '',
    /** 实际模型（运行时探测所得，如会话默认解析结果；跨轮保留） */
    actualModel: '',
    /** 本轮实际写入的 opencode 会话 ID（从事件流捕获） */
    sessionId: ''
  }
}

export class Daemon extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.lineLimit = opts.lineLimit ?? 800
    /** 可选：实际模型解析器 (sessionId) => Promise<string>（守护不直接依赖 CLI 实现） */
    this.resolveModel = typeof opts.resolveModel === 'function' ? opts.resolveModel : null
    /** 可选：托管服务端口冲突修复器 (port) => Promise<{ok, pid?}> */
    this.repairConflict = typeof opts.repairConflict === 'function' ? opts.repairConflict : null
    /** 会话闸门（均由主进程注入；缺失时保持旧行为：直接发送） */
    this.resolveSession = typeof opts.resolveSession === 'function' ? opts.resolveSession : null
    this.probeSession = typeof opts.probeSession === 'function' ? opts.probeSession : null
    this.waitSessionIdle = typeof opts.waitSessionIdle === 'function' ? opts.waitSessionIdle : null
    this.interruptSession = typeof opts.interruptSession === 'function' ? opts.interruptSession : null
    this.acquireSession = typeof opts.acquireSession === 'function' ? opts.acquireSession : null
    this.releaseSession = typeof opts.releaseSession === 'function' ? opts.releaseSession : null
    /** 错误策略：等待恢复的上限（防错误文案解析偏差导致无限长等） */
    this.policyMaxWaitMs = Number.isFinite(opts.policyMaxWaitMs) ? opts.policyMaxWaitMs : 24 * 3600 * 1000
    /** 模型受限探活间隔：额度/限流无明确恢复时间时，到点自动重试受限模型（默认 10 分钟） */
    this.modelProbeMs = Number.isFinite(opts.modelProbeMs) ? Math.max(1000, opts.modelProbeMs) : MODEL_PROBE_MS
    /** 模型受限冷却：模型 → 不可用截止时间；及受限原因（错误分类 kind） */
    this._modelCooldowns = new Map()
    this._modelCooldownKind = new Map()
    /** 已持有租约/本轮使用的会话（停止时据此中断服务器端执行） */
    this._leasedSession = ''
    this._roundSession = ''
    this._gateAbort = null
    this._gateWarned = false
    /** 会话等待期点击“立即重启”：仅重新探测，不结束守护 */
    this._gateRestart = false
    /** 会话等待期点击“跳过等待”：本轮不再等待直接发送（一次性，消费即清除） */
    this._gateForce = false
    this._svcFixes = 0
    this._svcPort = null
    this.state = initialState()
    /** 环形日志缓冲：{ time, level, title, detail } */
    this.lines = []
    this.proc = null
    this.cfg = null
    this.bin = null
    this.logFile = ''
    this.logWriter = new LogFileWriter()
    this.stopRequested = false
    this.skipDelay = false
    this.doneHit = false
    this.doneBuf = ''
    this.restartCount = 0
    this._timer = null
    this._wake = null
    this._gen = 0
  }

  get busy() {
    return this.state.status === 'running' || this.state.status === 'waiting'
  }

  emitState() {
    this.emit('state', { ...this.state })
  }

  emitLine(entry) {
    // detail 截断：opencode JSON 事件流可能出现超长单行，防止内存/IPC 膨胀
    const capped = {
      time: entry.time,
      level: entry.level,
      title: entry.title?.length > 200 ? entry.title.slice(0, 200) + '…' : entry.title,
      detail: entry.detail?.length > 8192 ? entry.detail.slice(0, 8192) + `\n…（已截断，完整内容见日志文件）` : entry.detail
    }
    this.lines.push(capped)
    if (this.lines.length > this.lineLimit) this.lines.splice(0, this.lines.length - this.lineLimit)
    this.emit('log', capped)
  }

  log(level, title, detail) {
    this.emitLine({ time: Date.now(), level, title, detail })
  }

  tail(n = 200) {
    return this.lines.slice(-n)
  }

  stateSnapshot() {
    return { state: { ...this.state }, lines: this.tail(400) }
  }

  async start(cfg, bin, caps = {}) {
    if (this.busy || this._starting) return { ok: false, error: '守护已在运行' }
    if (!cfg.project) return { ok: false, error: '请先在设置中配置项目目录' }
    if (!bin) return { ok: false, error: '未找到 opencode 可执行文件，请在设置中指定路径' }
    this._starting = true
    try {
      // 清理可能残留的旧进程（并发启动保护）
      if (this.proc) this._kill()
      this._gen++
      this.stopRequested = false
      this.skipDelay = false
      this.doneHit = false
      this.doneBuf = ''
      this._lineBuf = ''
      this._errBuf = ''
      this.restartCount = 0
      this._failStreak = 0
      this._nextLabel = ''
      this._modelCooldowns = new Map()
      this._modelCooldownKind = new Map()
      this._svcFixes = 0
      this._svcPort = null
      this._abortGate()
      this._releaseSessionLease()
      this._roundSession = ''
      this._gateWarned = false
      this._gateRestart = false
      this._gateForce = false
      this.cfg = cfg
      this.bin = bin
      this.caps = caps
      this.state = initialState()
      this.state.startedAt = Date.now()
      // 启动即视为运行中（会话闸门可能随后切换为 waiting）
      this.state.status = 'running'
      this.logFile = cfg.logFile || join(cfg.project, 'keep-alive.log')
      try {
        await mkdir(dirname(this.logFile), { recursive: true })
        this.logWriter.open(this.logFile)
      } catch {
        /* 日志目录创建失败时仅在应用内记录 */
      }
      this.log('info', `守护启动：项目 ${cfg.project}${cfg.autoApprove ? '（自动批准权限）' : '（手动审批）'}`)
      this.emitState()
      this._loop(this._gen)
      return { ok: true }
    } finally {
      this._starting = false
    }
  }

  stop(reason = '已手动停止') {
    if (!this.busy && this.state.status !== 'running') {
      this.stopRequested = true
      this._abortGate()
      this._releaseSessionLease()
      return
    }
    // 本轮由守护发起且仍在执行：停 CLI 后同步中断服务器端 agent loop，
    // 否则 kill 子进程只断开客户端，服务器仍会继续跑并在下一轮与 TUI 冲突。
    const interruptSid =
      this.state.status === 'running'
        ? this._roundSession ||
          this.state.sessionId ||
          (this.cfg?.sessionMode === 'id' ? this.cfg.sessionId : '')
        : ''
    this._gen++
    this.stopRequested = true
    this._abortGate()
    this._clearTimer()
    this._releaseSessionLease()
    this._kill(reason)
    this.state.status = 'stopped'
    this.state.nextRestartAt = null
    this.state.waitReason = ''
    this.state.sessionWaitStartedAt = null
    this.state.pid = null
    this.log('info', reason)
    this.emitState()
    this.logWriter.close()
    if (interruptSid) this._interruptServerSession(interruptSid)
  }

  /** 立即重启：等待期直接唤醒；运行中则终止当前轮跳过延时 */
  restartNow() {
    if (!this.busy) return
    if (this.state.status === 'waiting') {
      // 会话闸门等待：只唤醒重新探测（TUI 仍在跑时继续等待），不结束守护
      this._gateRestart = !!this.state.sessionWaitStartedAt
      this._abortGate()
      this._wake?.()
      return
    }
    const sid =
      this._roundSession ||
      this.state.sessionId ||
      (this.cfg?.sessionMode === 'id' ? this.cfg.sessionId : '')
    this.skipDelay = true
    this.log('info', '请求立即重启，终止当前轮')
    this._kill('当前轮已终止（立即重启）')
    if (sid) this._interruptServerSession(sid)
  }

  /** 唤醒会话闸门等待循环：中断当前长轮询/休眠并重新探测（仅会话等待期使用） */
  _wakeGate() {
    this._gateRestart = true
    this._abortGate()
    this._wake?.()
  }

  _assertSessionWait(action) {
    if (this.state.status === 'waiting' && this.state.sessionWaitStartedAt) return null
    return { ok: false, error: `仅会话等待中可${action}（当前状态：${this.state.status}）` }
  }

  /**
   * 等待期“跳过等待”：本轮不再等待空闲，唤醒闸门后直接发送。
   * 进程内租约仍然生效——会话被本应用其他任务持有时，跳过会等到拿到租约为止。
   */
  skipWait() {
    const guard = this._assertSessionWait('跳过等待')
    if (guard) return guard
    this._gateForce = true
    this.log('warn', '手动跳过会话等待：本轮将直接发送提示词')
    this._wakeGate()
    return { ok: true }
  }

  /**
   * 等待期“中断会话”：打断目标会话正在执行的回合（TUI/其他客户端），
   * 闸门随后探测到空闲自动放行；不结束守护。
   */
  async interruptTargetSession() {
    const guard = this._assertSessionWait('中断目标会话')
    if (guard) return guard
    const sid = this._leasedSession || (await this._resolveTargetSession())
    if (!sid) return { ok: false, error: '无法确定目标会话（新会话模式每轮新建，无需中断）' }
    this.log('warn', `手动中断目标会话 ${sid} 正在执行的回合`)
    this._interruptServerSession(sid)
    this._wakeGate()
    return { ok: true, sessionId: sid }
  }

  _clearTimer() {
    const wake = this._wake
    this._wake = null
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
    // 唤醒挂起的 _sleep：停止/终止后 _loop 立即检查代数并退出，不留悬挂计时
    if (wake) wake()
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._timer = setTimeout(() => {
        this._timer = null
        this._wake = null
        resolve()
      }, ms)
      this._wake = () => {
        this._clearTimer()
        resolve()
      }
    })
  }

  // ---------- 会话闸门：发送前等待目标会话空闲 ----------

  _abortGate() {
    const c = this._gateAbort
    this._gateAbort = null
    if (c) c.abort()
  }

  _releaseSessionLease() {
    const sid = this._leasedSession
    this._leasedSession = ''
    if (!sid || !this.releaseSession) return
    try {
      this.releaseSession(sid)
    } catch {
      /* 释放失败不影响主流程 */
    }
  }

  /** 停止/重启时中断服务器端执行：kill CLI 只断开客户端，服务器回合仍会继续 */
  _interruptServerSession(sessionId) {
    this._roundSession = ''
    if (!sessionId || !this.interruptSession) return
    Promise.resolve()
      .then(() => this.interruptSession(sessionId))
      .then((r) => {
        if (r?.ok) this.log('info', r.interrupted ? '已中断服务器端会话执行' : '服务器端执行已结束（无需中断）')
        else this.log('warn', `中断服务器端执行失败：${r?.error || '未知原因'}`)
      })
      .catch((err) => this.log('warn', `中断服务器端执行失败：${String(err?.message || err)}`))
  }

  async _resolveTargetSession() {
    if (this.resolveSession) {
      try {
        return String((await this.resolveSession(this.cfg)) || '')
      } catch {
        return ''
      }
    }
    return this.cfg?.sessionMode === 'id' ? String(this.cfg.sessionId || '') : ''
  }

  _setSessionWait(reason, startedAt) {
    const changed =
      this.state.status !== 'waiting' ||
      this.state.waitReason !== reason ||
      !this.state.sessionWaitStartedAt
    this.state.status = 'waiting'
    this.state.waitReason = reason
    this.state.nextRestartAt = null
    this.state.sessionWaitStartedAt = this.state.sessionWaitStartedAt || startedAt
    if (changed) this.emitState()
  }

  _clearSessionWait() {
    if (!this.state.sessionWaitStartedAt && this.state.status !== 'waiting') return
    this.state.sessionWaitStartedAt = null
    this.state.waitReason = ''
    this.emitState()
  }

  /**
   * 发送前闸门：目标会话运行中 / 有排队消息时等待空闲。
   * 返回 { ok, sessionId }；ok=true 表示已拿到会话租约、可以 spawn。
   * 等待上限取任务配置 sessionWaitLimitMin（分钟，0=不限，默认 30）。
   */
  async _sessionGate(gen) {
    const sid = await this._resolveTargetSession()
    if (!sid || !this.probeSession) return { ok: true, sessionId: sid }

    const limit = waitLimitMs(this.cfg)
    const onTimeout = timeoutAction(this.cfg)
    const startedAt = Date.now()
    const deadline = limit > 0 ? startedAt + limit : 0
    let announced = ''
    let lastInbox = -1
    let lastHeartbeat = Date.now()
    let leaseTimeoutWarned = false

    while (gen === this._gen && !this.stopRequested) {
      this._gateRestart = false
      this._gateAbort = new AbortController()
      // 1) 进程内租约：同一会话同时只允许一个守护发送
      const lease = this.acquireSession ? await this.acquireSession(sid) : { ok: true }
      if (!lease.ok) {
        this._leasedSession = ''
        const owner = lease.ownerName || lease.owner || '其他任务'
        const reason = `会话正被任务「${owner}」占用，等待其结束`
        this._setSessionWait(reason, startedAt)
        if (announced !== reason) {
          this.log('warn', `${reason}（同一会话不建议配置多个守护任务）`)
          announced = reason
        }
        if (deadline && Date.now() >= deadline) {
          if (onTimeout === 'stop') {
            this.log('warn', `等待已超过上限（${formatWait(limit)}），且会话仍被任务「${owner}」占用；按配置停止守护`)
            this.stop('会话等待超时，按任务配置停止守护')
            return { ok: false }
          }
          if (!leaseTimeoutWarned) {
            leaseTimeoutWarned = true
            this.log('warn', `等待已超过上限（${formatWait(limit)}），但会话仍被任务「${owner}」占用；为避免并发投递继续等待`)
          }
        }
        await this._sleep(5000)
        continue
      }
      this._leasedSession = sid

      // 1.5) 跳过等待：本轮直接发送（仍需先拿到租约，保证进程内单写者）
      if (this._gateForce) {
        this._gateForce = false
        this.log('warn', '已跳过会话等待，本轮直接发送（目标会话可能仍在运行）')
        this._clearSessionWait()
        return { ok: true, sessionId: sid }
      }

      // 2) 服务端状态：/api/session/active 才是权威的“正在执行”标记
      const probe = await this.probeSession(sid).catch((err) => ({ ok: false, error: String(err?.message || err) }))
      if (gen !== this._gen || this.stopRequested) return { ok: false }

      if (!probe.ok) {
        // API 不可用（旧版本/服务未启动）：退回旧行为，避免把守护永久卡死
        if (!this._gateWarned) {
          this._gateWarned = true
          this.log('warn', `无法读取会话 ${sid} 的状态（${probe.error || 'API 不可用'}），跳过等待直接发送`)
        }
        this._clearSessionWait()
        return { ok: true, sessionId: sid }
      }

      if (!sessionBusy(probe)) {
        if (announced) this.log('info', `会话 ${sid} 已空闲（上次结果：${outcomeText(probe.outcome)}），开始发送本轮提示词`)
        this._clearSessionWait()
        return { ok: true, sessionId: sid }
      }

      // 3) 忙：更新等待状态并输出原因（运行中 / 排队消息条数）
      const reason = busyReason(probe)
      this._setSessionWait(reason, startedAt)
      if (announced !== reason) {
        const limitText = limit > 0 ? `最多等待 ${formatWait(limit)}` : '不设等待上限'
        this.log('warn', `${reason}，本轮暂不发送提示词（${limitText}；可在任务的“会话等待上限”调整）`)
        announced = reason
      }
      const inbox = Number(probe.inbox) || 0
      if (inbox !== lastInbox) {
        if (lastInbox >= 0) this.log('info', `会话排队消息变化：${lastInbox} → ${inbox} 条`)
        lastInbox = inbox
      }
      if (Date.now() - lastHeartbeat >= 5 * 60 * 1000) {
        lastHeartbeat = Date.now()
        this.log('info', `仍在等待会话空闲（已等待 ${formatWait(Date.now() - startedAt)}；${reason}）`)
      }

      // 4) 等待上限：只对“会话忙”生效；超时处置按任务配置（继续发送 / 停止守护）
      if (deadline && Date.now() >= deadline) {
        if (onTimeout === 'stop') {
          this.log('warn', `等待会话空闲已超过上限（${formatWait(limit)}），按配置停止守护`)
          this.stop('会话等待超时，按任务配置停止守护')
          return { ok: false }
        }
        this.log('warn', `等待会话空闲已超过上限（${formatWait(limit)}），按配置继续发送；目标会话可能仍在运行`)
        this._clearSessionWait()
        return { ok: true, sessionId: sid }
      }

      const remaining = deadline ? deadline - Date.now() : 0
      const timeoutMs = deadline ? Math.max(1000, Math.min(30000, remaining)) : 30000
      if (this.waitSessionIdle) {
        const r = await this.waitSessionIdle(sid, { timeoutMs, signal: this._gateAbort?.signal })
        if (gen !== this._gen || this.stopRequested) return { ok: false }
        if (r?.aborted) {
          // “立即重启”只唤醒重新探测；停止才结束等待
          if (this._gateRestart && !this.stopRequested && gen === this._gen) continue
          return { ok: false }
        }
        if (r && !r.ok && r.status === 503 && !this._gateWarned) {
          this._gateWarned = true
          this.log('warn', '会话等待接口不可用（503），改为轮询会话状态')
        }
        // 接口立即返回时避免忙轮询；_sleep 可被停止操作立即唤醒
        await this._sleep(r?.ok ? 500 : 5000)
      } else {
        await this._sleep(5000)
      }
    }
    return { ok: false }
  }

  /** 检测输出中的 opencode 托管服务端口冲突（45278 被僵死服务占用） */
  _detectSvcConflict(text) {
    const m = String(text || '').match(/Managed service port (\d+) on 127\.0\.0\.1 is already in use/)
    if (m) this._svcPort = Number(m[1])
  }

  /** 轮内错误文本累计（供退出后分类定策略；封顶防膨胀） */
  _pushErr(text) {
    if (!text) return
    this._errBuf = `${this._errBuf || ''}\n${text}`.slice(-65536)
  }

  _kill(reason) {
    const p = this.proc
    this.proc = null
    if (!p || p.exitCode !== null || p.killed) return
    if (process.platform === 'win32') {
      // Windows：终结整棵进程树（opencode 可能派生子进程）
      spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true })
    } else {
      p.kill('SIGTERM')
    }
    if (reason) this.log('info', reason)
  }

  async _loop(gen) {
    try {
      await this._loopRounds(gen)
    } finally {
      this._releaseSessionLease()
      this._abortGate()
      this._roundSession = ''
    }
  }

  async _loopRounds(gen) {
    while (gen === this._gen && !this.stopRequested && !this.doneHit) {
      // 发送前会话闸门：TUI/其他客户端正在运行时先等待空闲，避免 opencode run 以 steer 插话
      const gate = await this._sessionGate(gen)
      if (!gate.ok || gen !== this._gen || this.stopRequested) return
      const code = await this._runOnce(gen)
      this._releaseSessionLease()
      if (gen !== this._gen) return
      if (this.stopRequested) return

      // 托管服务端口冲突：自动修复（结束僵死服务进程）后立即重试，不计入失败重启
      if (this._svcPort && !this.doneHit) {
        const port = this._svcPort
        this._svcPort = null
        if (this.repairConflict && this._svcFixes < 3) {
          this._svcFixes++
          this.state.status = 'waiting'
          this.state.nextRestartAt = null
          this.log('warn', `检测到 opencode 托管服务端口 ${port} 冲突，正在自动修复（第 ${this._svcFixes}/3 次）…`)
          this.emitState()
          const r = await this.repairConflict(port).catch(() => null)
          if (r && r.ok) this.log('info', `已结束僵死的 opencode 服务进程（pid ${r.pid}），即将重试`)
          else this.log('warn', `自动修复未执行：${r?.reason === 'not-opencode' ? `端口被 ${r.name}(pid ${r.pid}) 占用` : r?.reason || '无监听进程'}`)
          await this._sleep(3000)
          if (gen !== this._gen) return
          continue
        }
        this.log('warn', '托管服务端口冲突重试已达上限，按普通失败处理')
      }

      let delaySec = Math.max(1, Number(this.cfg.retryDelay) || 1)
      let untilMs = null

      if (this.doneHit) {
        // 迭代模式：DONE 轮完成后自动开始下一轮，直至总轮数上限
        if ((this.cfg.onDone || 'stop') === 'next') {
          if (this.cfg.maxRounds > 0 && this.state.runs >= this.cfg.maxRounds) {
            this.state.status = 'done'
            this.state.nextRestartAt = null
            this.log('info', `已达总轮数上限（${this.cfg.maxRounds} 轮），守护完成退出`)
            this.emitState()
            this.logWriter.close()
            return
          }
          this.log('info', `第 ${this.state.runs} 轮完成（迭代模式），${this.cfg.retryDelay} 秒后自动开始下一轮`)
          this.doneHit = false
          this.doneBuf = ''
          this.state.waitReason = ''
          this._nextLabel = '迭代'
        } else {
          this.state.status = 'done'
          this.state.nextRestartAt = null
          this.state.waitReason = ''
          this.log('info', `检测到完成标记「${this.cfg.doneKeyword}」，守护完成退出`)
          this.emitState()
          this.logWriter.close()
          return
        }
      } else {
        // 错误分类 → 分级处理策略（额度等恢复、鉴权停止、限流退避、常规重启）
        const cls = classifyError(this._errBuf)
        const models = effectiveModels(this.cfg)
        const roundModel = this.state.model || models[0] || ''
        const now = Date.now()
        // 受限模型进入冷却：额度/限流/鉴权失败后，到点自动重试（探到恢复即切回主力）
        if (models.length > 1) {
          const until = cooldownUntil(cls, now, this.modelProbeMs)
          if (until) {
            this._modelCooldowns.set(roundModel, until)
            this._modelCooldownKind.set(roundModel, cls.kind)
          }
        }
        // 备选可用性：链中还有当前未受限的其他模型（冷却中的模型只排队，不算可用）
        const hasFallback = models.some(
          (m) => m !== roundModel && (this._modelCooldowns.get(m) || 0) <= now
        )
        const plan = planRecovery(cls, {
          hasFallback,
          retryDelaySec: this.cfg.retryDelay,
          now,
          maxWaitMs: this.policyMaxWaitMs
        })
        this.state.errorKind = cls.kind
        const tag =
          cls.kind !== 'unknown' ? `（${KIND_TEXT[cls.kind] || cls.kind}${cls.match ? `：${cls.match}` : ''}）` : ''

        if (plan.action === 'stop') {
          // 鉴权失败且无备选：同配置重试无意义，明确停止
          this.state.status = 'error'
          this.state.lastError = plan.reason
          this.state.nextRestartAt = null
          this.state.waitReason = ''
          this.log('error', `守护停止：${plan.reason}${tag}`)
          this.emitState()
          this.logWriter.close()
          return
        }

        if (plan.action === 'wait') {
          // 额度/限流窗口：等恢复时间到达后自动拉起，不消耗重启次数
          let waitUntil = plan.until
          // 其他模型更早解封时按更早的时刻重试（如备选受限更久，主力稍后就能恢复）
          const earlier = this._earliestUnblock(now, roundModel)
          if (earlier && earlier < waitUntil) {
            waitUntil = Math.max(now + 1000, earlier)
            this.log('info', `其他模型将更早解封（${formatClock(waitUntil)}），先等到该时刻再重试`)
          }
          this._nextLabel = '额度恢复'
          this.state.waitReason = plan.reason
          this.log(
            'warn',
            `${KIND_TEXT[cls.kind] || cls.kind}（${cls.match || '未识别详情'}）：已排定 ${formatClock(waitUntil)} 自动继续` +
              `（等待 ${formatWait(waitUntil - now)}，不消耗重启次数）`
          )
          untilMs = waitUntil
          delaySec = 0
        } else {
          // 失败重启：计数仅用于 maxRestarts 上限
          this.restartCount++
          if (this.cfg.maxRestarts > 0 && this.restartCount >= this.cfg.maxRestarts) {
            this.state.status = 'error'
            this.state.lastError = `重启次数达到上限（${this.cfg.maxRestarts}），守护停止`
            this.log('error', this.state.lastError)
            this.emitState()
            this.logWriter.close()
            return
          }
          this._nextLabel = `重启 #${this.restartCount}`
          this.state.waitReason = plan.reason || ''
          delaySec = Math.max(1, Number(plan.delaySec) || Number(this.cfg.retryDelay) || 1)
          this.log(
            'info',
            `进程退出（exit=${code ?? '?'}），${delaySec} 秒后重启（第 ${this.restartCount} 次）${tag}`
          )
        }
      }

      this.state.status = 'waiting'
      let nextAt = untilMs != null ? untilMs : Date.now() + delaySec * 1000
      // 模型链全部受限：等到最早解封再试，避免对仍在冷却的模型反复请求
      const atNext = selectModel(this.cfg, this._modelCooldowns, nextAt)
      if (atNext.blockedUntil) {
        this.log('info', `模型链均在冷却中，推迟到 ${formatClock(atNext.blockedUntil)} 再重试`)
        nextAt = atNext.blockedUntil
      }
      this.state.nextRestartAt = nextAt
      this.emitState()
      // 「立即重启」终止当前轮后跳过重启延时（skipDelay 由 restartNow 设置，此处消费）
      if (!this.skipDelay) {
        await this._sleep(Math.max(1000, this.state.nextRestartAt - Date.now()))
        if (gen !== this._gen) return
      }
      this.skipDelay = false
      this.state.nextRestartAt = null
    }
  }

  /** 其他模型最早的解封时刻（epoch ms；无则 0） */
  _earliestUnblock(now = Date.now(), exclude = '') {
    let best = 0
    for (const [model, until] of this._modelCooldowns) {
      if (model === exclude) continue
      const t = Number(until) || 0
      if (t > now && (!best || t < best)) best = t
    }
    return best
  }

  /**
   * 本轮模型选择 + 切回主力的日志/状态说明。
   * 主力受限（额度/限流/鉴权）→ 降级到未受限备选；冷却到期 → 自动切回主力。
   */
  _nextModel(now = Date.now()) {
    const models = effectiveModels(this.cfg)
    const prefer = Math.min(Math.max(this._failStreak || 0, 0), Math.max(models.length - 1, 0))
    const picked = selectModel(this.cfg, this._modelCooldowns, now, prefer)
    if (!models.length) {
      this.state.modelNote = ''
      return picked
    }
    const primary = models[0]
    const prev = this.state.model || ''
    const primaryUntil = this._modelCooldowns.get(primary) || 0
    if (picked.index === 0 && primaryUntil <= now) {
      // 主力可用（冷却到期或被探活确认恢复）：清理冷却并按需提示切回
      const had = this._modelCooldowns.has(primary)
      const kind = this._modelCooldownKind.get(primary) || ''
      this._modelCooldowns.delete(primary)
      this._modelCooldownKind.delete(primary)
      this.state.modelNote = ''
      if (had) {
        const reason = LIMIT_TEXT[kind] || '限制'
        if (prev && prev !== primary) this.log('info', `主力模型 ${primary} 的${reason}已解除，自动切回主力模型`)
        else this.log('info', `主力模型 ${primary} 已恢复可用，继续使用主力模型`)
      }
      return picked
    }
    if (picked.blockedUntil) {
      // 全部模型都在冷却：按最早解封的一个提前试探，避免整条链停摆
      this.state.modelNote = `模型链均受限，按最早解封的 ${picked.model} 提前重试（${formatClock(picked.blockedUntil)}）`
    } else if (primaryUntil > now) {
      const kind = this._modelCooldownKind.get(primary) || ''
      this.state.modelNote =
        `主力模型 ${primary} ${LIMIT_TEXT[kind] || '受限'}，已切换备选 ${picked.model}` +
        `（预计 ${formatClock(primaryUntil)} 重试主力）`
    } else {
      // 备用模型顺延（非额度类连续失败）：不涉及主力冷却
      this.state.modelNote = `主力模型 ${primary} 连续失败，已切换备选 ${picked.model}`
    }
    if (prev !== picked.model) this.log('warn', this.state.modelNote)
    return picked
  }

  _spawnCmd(model = '') {
    const args = buildRunArgs(this.cfg, this.caps || {}, model)
    const prompt = expandPrompt(this.cfg.prompt, { project: this.cfg.project })
    if (!prompt) return { error: '提示词为空，请在「提示词」页配置' }
    this._roundModel = model
    const all = [...args, prompt]
    if (this.bin.direct) {
      return { file: this.bin.path, args: all }
    }
    // 经 shell 兜底（路径未解析到 exe 时）：verbatim 传递，cmd 内用 "" 转义
    const q = (s) => (/\s/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s).replace(/"/g, '""'))
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `${this.bin.path} ${all.map(q).join(' ')}`], verbatim: true }
  }

  _runOnce(gen) {
    return new Promise((resolve) => {
      const picked = this._nextModel()
      const cmd = this._spawnCmd(picked.model)
      if (cmd.error) {
        this.state.status = 'error'
        this.state.lastError = cmd.error
        this.log('error', cmd.error)
        this.emitState()
        resolve(null)
        return
      }

      this.state.status = 'running'
      this.state.runs++
      this.state.roundStartedAt = Date.now()
      this.state.model = this._roundModel || ''
      this._errBuf = ''
      this.state.waitReason = ''
      this.state.sessionWaitStartedAt = null
      // 本轮会话：停止时据此中断服务器端执行
      this._roundSession =
        this._leasedSession || (this.cfg?.sessionMode === 'id' ? String(this.cfg.sessionId || '') : '')
      const modelTag = this._roundModel ? ` · 模型 ${this._roundModel}` : ''
      const kind = this._nextLabel || '首轮'
      this._nextLabel = ''
      this.log('info', `第 ${this.state.runs} 轮启动（${kind}${modelTag}）`)
      this.emitState()

      let child
      try {
        child = spawn(cmd.file, cmd.args, {
          cwd: this.cfg.project,
          windowsHide: true,
          windowsVerbatimArguments: !!cmd.verbatim,
          // stdin 必须 ignore：opencode run 支持管道输入消息，管道 stdin 永不 EOF 会让它无限等待
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        })
      } catch (err) {
        this.state.status = 'error'
        this.state.lastError = String(err?.message || err)
        this.log('error', `启动失败：${this.state.lastError}`)
        this.emitState()
        resolve(null)
        return
      }

      this.proc = child
      this.state.pid = child.pid
      this.emitState()

      // 每轮独立的 UTF-8 解码器：中文等多字节字符跨 chunk 边界时不会乱码
      const decOut = new StringDecoder('utf-8')
      const decErr = new StringDecoder('utf-8')

      let settled = false
      const finish = (code) => {
        if (settled) return
        settled = true
        if (gen !== this._gen) {
          resolve(code)
          return
        }
        this.state.lastExitCode = code
        this.state.pid = null
        // 轮结束：探测该会话实际使用的模型（会话默认解析结果），异步更新展示
        const sid = this.state.sessionId
        if (sid && this.resolveModel) {
          Promise.resolve(this.resolveModel(sid))
            .then((m) => {
              if (m && gen === this._gen) {
                this.state.actualModel = m
                this.emitState()
              }
            })
            .catch(() => {})
        }
        // 轮换计数：正常退出重置回主力；异常退出递增顺延可选模型（额度等受限改由冷却窗口控制）
        if (code === 0) this._failStreak = 0
        else this._failStreak = (this._failStreak || 0) + 1
        const level = this.stopRequested ? 'info' : code === 0 ? 'info' : 'error'
        this.log(
          level,
          `第 ${this.state.runs} 轮退出：exit=${code ?? 'null'}${this.stopRequested ? '（手动停止）' : ''}`
        )
        this.proc = null
        resolve(code)
      }

      // onChunk 接收已解码文本（解码器按轮独立，见 decOut/decErr）
      const onChunk = (text, stream) => {
        this._writeLog(text)
        this._detectSvcConflict(text)
        if (stream === 'stderr') return
        this.doneBuf = (this.doneBuf + text).slice(-DONE_BUF_CAP)
        if (!this.doneHit && isDone(this.doneBuf, this.cfg.doneKeyword)) {
          this.doneHit = true
          this.state.doneAt = Date.now()
          this.log('info', `输出中出现完成标记「${this.cfg.doneKeyword}」`)
          // 不立即 kill：等子进程自然退出，保证收尾动作（如 git commit）执行完
        }
        // 行缓冲：跨 chunk 的半行留到下一片拼接，避免 JSON 行撕裂解析失败
        this._lineBuf = (this._lineBuf || '') + text
        const lines = this._lineBuf.split(/\r?\n/)
        this._lineBuf = lines.pop() || ''
        for (const line of lines) {
          this._emitParsedLine(line)
        }
      }

      const onStderrText = (text) => {
        this._writeLog(text)
        this._detectSvcConflict(text)
        const t = text.trim()
        // stderr 错误文案纳入分类缓冲（额度不足等错误常经 stderr 输出）
        if (t) this._pushErr(t)
        if (t) this.emitLine({ time: Date.now(), level: 'warn', title: clip(t, 160), detail: t })
      }

      child.stdout.on('data', (b) => onChunk(decOut.write(b), 'stdout'))
      child.stderr.on('data', (b) => onStderrText(decErr.write(b)))

      child.on('error', (err) => {
        this.state.lastError = String(err?.message || err)
        this.log('error', `进程错误：${this.state.lastError}`)
        finish(-1)
      })
      // close（而非 exit）：stdio 流全部关闭后触发，保证最后一批输出（可能含
      // DONE 标记或最终错误事件）先于完成判定被处理，避免完成的轮被误判为失败
      child.on('close', (code) => {
        // 冲刷解码器残字与残行缓冲（最后一行可能无换行符）
        const tailOut = decOut.end()
        if (tailOut) onChunk(tailOut, 'stdout')
        const tailErr = decErr.end()
        if (tailErr) onStderrText(tailErr)
        const rest = (this._lineBuf || '').trim()
        this._lineBuf = ''
        if (rest) this._emitParsedLine(rest)
        finish(code)
      })
    })
  }

  /** 解析单行输出：JSON 事件行语义化展示并捕获会话 ID，非 JSON 行原样展示 */
  _emitParsedLine(line) {
    const t = line.trim()
    if (!t) return
    if (t.startsWith('{')) {
      const ev = parseRunEvent(t)
      if (ev?.sessionId && ev.sessionId !== this.state.sessionId) {
        // 捕获本轮实际写入的 opencode 会话
        this.state.sessionId = ev.sessionId
        this.emitState()
      }
      if (ev && !ev.skip) {
        this.emitLine({ time: Date.now(), level: ev.level, title: ev.title, detail: ev.detail })
        // 错误事件纳入轮内错误缓冲，供退出后分类定策略
        if (ev.level === 'error' && ev.errorText) this._pushErr(ev.errorText)
      }
    } else {
      this.emitLine({ time: Date.now(), level: 'info', title: clip(t, 160), detail: t })
    }
  }

  _writeLog(text) {
    if (!this.logFile || !text) return
    this.logWriter.write(text)
  }
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function logLineFormat(entry) {
  return `[${ts(entry.time)}] [${entry.level}] ${entry.title}`
}
