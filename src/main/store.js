/**
 * store.js — 应用配置持久化（userData/config.json，原子写盘）
 * v2 数据模型：全局设置 + tasks[]（多守护任务）；首次加载自动从 v1 扁平字段迁移。
 */
import { copyFile, readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'

/** 全局缺省配置 */
export function defaultConfig() {
  return {
    opencodePath: 'opencode',
    closeToTray: true,
    /** 随系统开机启动应用（托盘隐藏运行） */
    loginAtBoot: false,
    /** 启动时检查更新（只提醒，不自动下载） */
    checkUpdateOnStart: true,
    /** 模型额度/限流受限后的探活间隔（秒）：越短，充值/解封后切回主力越快 */
    modelProbeSec: 60,
    theme: 'system',
    promptPresets: [],
    /** 主窗口位置与尺寸（跨启动记忆） */
    windowBounds: null,
    /** v2：守护任务列表 */
    tasks: []
  }
}

/** 任务缺省值（提示词模板取自 keep-alive.ps1 实战版） */
export function taskDefaults() {
  return {
    id: '',
    name: '',
    project: '',
    attachUrl: 'http://localhost:4096',
    /** 'last' → -c；'id' → -s；'new' → 新会话 */
    sessionMode: 'last',
    sessionId: '',
    /** 主力模型（provider/model）；空 = opencode 默认 */
    model: '',
    /** 可选模型链：主力轮失败后按序轮换 */
    fallbackModels: [],
    retryDelay: 120,
    maxRestarts: 0,
    /** 发送前等待目标会话空闲的上限（分钟，0 = 不限；默认 30） */
    sessionWaitLimitMin: 30,
    /** 等待超时处置：'send' 继续发送并告警；'stop' 停止守护 */
    sessionWaitTimeoutAction: 'send',
    prompt:
      '读取 .progress.md，继续完成未完成的任务。全部完成后输出 DONE。请自主规划、执行、验证、迭代、反思，不得访问项目目录外的系统文件，不要中途请求确认或等待授权，失败就自己诊断修正并继续，直到任务通过验证。修改完自动提交，不要推送代码。',
    doneKeyword: 'DONE',
    /** 完成后动作：'stop' 停止守护；'next' 自动开始下一轮（迭代模式） */
    onDone: 'stop',
    /** 迭代模式总轮数上限（0 = 无限） */
    maxRounds: 0,
    autoApprove: true,
    logFile: '',
    /** 应用启动时自动开始该任务 */
    autoStart: false
  }
}

export function newTaskId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 补全/纠正单个任务字段（未知键丢弃，类型按缺省值纠正） */
export function sanitizeTask(input) {
  const base = taskDefaults()
  const out = { ...base, id: String(input?.id || '').trim() || newTaskId() }
  for (const k of Object.keys(base)) {
    if (k === 'id' || !(k in (input || {}))) continue
    const v = input[k]
    if (k === 'fallbackModels') {
      out[k] = Array.isArray(v) ? v.map((s) => String(s || '').trim()).filter(Boolean) : []
      continue
    }
    if (k === 'onDone' && v !== 'next') {
      out[k] = 'stop'
      continue
    }
    if (k === 'sessionWaitTimeoutAction' && v !== 'stop') {
      out[k] = 'send'
      continue
    }
    if (typeof base[k] === 'boolean') out[k] = Boolean(v)
    else if (typeof base[k] === 'number') {
      const n = Number(v)
      out[k] = Number.isFinite(n) ? n : base[k]
    } else out[k] = v == null ? base[k] : String(v)
  }
  if (!out.name) out.name = out.project ? basename(out.project) || '未命名任务' : '未命名任务'
  return out
}

/** v1 扁平字段 → 单任务迁移 */
export function taskFromLegacy(cfg) {
  return sanitizeTask({
    ...cfg,
    id: newTaskId(),
    name: cfg.project ? basename(cfg.project) : '默认任务',
    autoStart: cfg.autoStart
  })
}

export function mergeConfig(base, partial) {
  const next = { ...base }
  for (const [k, v] of Object.entries(partial || {})) {
    if (!(k in base)) continue
    if (k === 'tasks') {
      next.tasks = Array.isArray(v) ? v.map(sanitizeTask) : base.tasks
      continue
    }
    if (k === 'promptPresets') {
      next[k] = Array.isArray(v) ? v : base[k]
      continue
    }
    if (typeof base[k] === 'boolean') next[k] = Boolean(v)
    else if (typeof base[k] === 'number') {
      const n = Number(v)
      next[k] = Number.isFinite(n) ? n : base[k]
    } else if (typeof base[k] === 'object') {
      // 对象（含可空对象）缺省：以写入值的类型为准——避免历史坏值（如字符串）把后续对象写入永久 String 化
      if (v == null) next[k] = base[k]
      else if (typeof v === 'object') next[k] = v
      else next[k] = base[k]
    } else next[k] = v == null ? base[k] : String(v)
  }
  return next
}

export class ConfigStore {
  constructor(file) {
    this.file = file
    this.data = defaultConfig()
    /** 写盘串行链：避免并发保存（config:set 与窗口位置防抖）争抢同一临时文件 */
    this._saveChain = Promise.resolve()
  }

  async load() {
    let raw = {}
    try {
      raw = JSON.parse(await readFile(this.file, 'utf-8'))
    } catch (err) {
      // 文件存在但解析失败（损坏）：先保留现场备份再回退缺省，
      // 避免随后的迁移保存直接覆盖原始数据，用户还有排查/抢救的机会
      if (err && err.code !== 'ENOENT') {
        await copyFile(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
    }
    this.data = mergeConfig(defaultConfig(), raw)
    // v1 → v2 迁移：无任务时从扁平字段生成一个默认任务
    if (!Array.isArray(this.data.tasks) || this.data.tasks.length === 0) {
      const legacy = { ...defaultConfig(), ...raw }
      this.data.tasks = [taskFromLegacy(legacy)]
      await this.save().catch(() => {})
    }
    return this.data
  }

  get all() {
    return {
      ...this.data,
      promptPresets: this.data.promptPresets.map((p) => ({ ...p })),
      tasks: this.data.tasks.map((t) => ({ ...t }))
    }
  }

  async update(partial) {
    this.data = mergeConfig(this.data, partial || {})
    await this.save()
    return this.all
  }

  async save() {
    this._saveChain = this._saveChain.catch(() => {}).then(() => this._saveNow())
    return this._saveChain
  }

  async _saveNow() {
    await mkdir(dirname(this.file), { recursive: true })
    // 唯一临时文件名：即使外部并发写也不会互相覆盖
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    try {
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf-8')
      await rename(tmp, this.file)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}

export function configPath(userDataDir) {
  return join(userDataDir, 'config.json')
}
