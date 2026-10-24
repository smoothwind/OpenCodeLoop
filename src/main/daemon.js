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
import { dirname, join } from 'node:path'
import { classifyError, planRecovery, KIND_TEXT, formatClock, formatWait } from './errpolicy.js'

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
 * 轮换策略：连续失败 N 次用链中第 min(N, len-1) 个——主力始终优先，回退稳定后不再摇摆。
 */
export function effectiveModels(cfg) {
  const list = [cfg?.model, ...(cfg?.fallbackModels || [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
  return [...new Set(list)]
}

export function pickModel(cfg, failStreak) {
  const models = effectiveModels(cfg)
  if (!models.length) return ''
  return models[Math.min(Math.max(failStreak, 0), models.length - 1)]
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
      // opencode run --format json 的错误事件：
      // { type:'error', error:{ name, data:{ message, statusCode, isRetryable } } }
      const err = e.error && typeof e.error === 'object' ? e.error : {}
      const data = err.data && typeof err.data === 'object' ? err.data : {}
      const msg = String(e.message || part.message || data.message || err.name || part.error || '未知错误')
      const code = Number(data.statusCode || e.statusCode) || 0
      const codeTag = code ? `（HTTP ${code}）` : ''
      return {
        level: 'error',
        title: `[错误] ${msg.slice(0, 180)}${codeTag}`,
        detail: t.slice(0, 4000),
        sessionId,
        errorText: `${msg}${code ? ` statusCode=${code}` : ''}`
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
    pid: null,
    /** 本轮实际使用的模型（配置解析值，轮启动设置） */
    model: '',
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
    /** 错误策略：等待恢复的上限（防错误文案解析偏差导致无限长等） */
    this.policyMaxWaitMs = Number.isFinite(opts.policyMaxWaitMs) ? opts.policyMaxWaitMs : 24 * 3600 * 1000
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
    this._svcFixes = 0
    this._svcPort = null
    this.cfg = cfg
      this.bin = bin
      this.caps = caps
      this.state = initialState()
      this.state.startedAt = Date.now()
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
      return
    }
    this._gen++
    this.stopRequested = true
    this._clearTimer()
    this._kill(reason)
    this.state.status = 'stopped'
    this.state.nextRestartAt = null
    this.state.waitReason = ''
    this.state.pid = null
    this.log('info', reason)
    this.emitState()
    this.logWriter.close()
  }

  /** 立即重启：等待期直接唤醒；运行中则终止当前轮跳过延时 */
  restartNow() {
    if (!this.busy) return
    if (this.state.status === 'waiting') {
      this._wake?.()
    } else {
      this.skipDelay = true
      this.log('info', '请求立即重启，终止当前轮')
      this._kill('当前轮已终止（立即重启）')
    }
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
    while (gen === this._gen && !this.stopRequested && !this.doneHit) {
      const code = await this._runOnce(gen)
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
        const hasFallback = models.length > 1 && (this._failStreak || 0) < models.length - 1
        const plan = planRecovery(cls, {
          hasFallback,
          retryDelaySec: this.cfg.retryDelay,
          now: Date.now(),
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
          this._nextLabel = '额度恢复'
          this.state.waitReason = plan.reason
          this.log(
            'warn',
            `${KIND_TEXT[cls.kind] || cls.kind}（${cls.match || '未识别详情'}）：已排定 ${formatClock(plan.until)} 自动继续` +
              `（等待 ${formatWait(plan.until - Date.now())}，不消耗重启次数）`
          )
          untilMs = plan.until
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
          // 事件流中已识别出需切换模型的错误但退出码为 0 时，同样顺延备选
          if (plan.switchModel && code === 0) this._failStreak = (this._failStreak || 0) + 1
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
      this.state.nextRestartAt = untilMs != null ? untilMs : Date.now() + delaySec * 1000
      this.emitState()
      await this._sleep(Math.max(1000, this.state.nextRestartAt - Date.now()))
      if (gen !== this._gen) return
      this.skipDelay = false
      this.state.nextRestartAt = null
    }
  }

  _spawnCmd() {
    // 模型轮换：主力连续失败后按可选模型链顺延
    const model = pickModel(this.cfg, this._failStreak || 0)
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
      const cmd = this._spawnCmd()
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
        // 轮换计数：正常退出重置回主力；异常退出递增顺延可选模型
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

      const onChunk = (buf, stream) => {
        const text = buf.toString('utf-8')
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
          const t = line.trim()
          if (!t) continue
          // JSON 事件行：识别为智能体交互（AI 文本/工具/错误）则语义化展示；
          // 未识别事件类型（step_start 等）仅用于捕获实际会话 ID；非 JSON 行按原始输出展示
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
      }

      child.stdout.on('data', (b) => onChunk(b, 'stdout'))
      child.stderr.on('data', (b) => {
        const text = b.toString('utf-8')
        this._writeLog(text)
        this._detectSvcConflict(text)
        const t = text.trim()
        // stderr 错误文案纳入分类缓冲（额度不足等错误常经 stderr 输出）
        if (t) this._pushErr(t)
        if (t) this.emitLine({ time: Date.now(), level: 'warn', title: clip(t, 160), detail: t })
      })

      child.on('error', (err) => {
        this.state.lastError = String(err?.message || err)
        this.log('error', `进程错误：${this.state.lastError}`)
        finish(-1)
      })
      child.on('exit', (code) => {
        // 冲刷残行缓冲（最后一行可能无换行符）
        const rest = (this._lineBuf || '').trim()
        this._lineBuf = ''
        if (rest) {
          if (rest.startsWith('{')) {
            const evEvent = parseRunEvent(rest)
            if (evEvent?.sessionId && evEvent.sessionId !== this.state.sessionId) {
              this.state.sessionId = evEvent.sessionId
              this.emitState()
            }
            if (evEvent && !evEvent.skip) {
              this.emitLine({ time: Date.now(), level: evEvent.level, title: evEvent.title, detail: evEvent.detail })
              if (evEvent.level === 'error' && evEvent.errorText) this._pushErr(evEvent.errorText)
            }
          } else {
            this.emitLine({ time: Date.now(), level: 'info', title: clip(rest, 160), detail: rest })
          }
        }
        finish(code)
      })
    })
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
