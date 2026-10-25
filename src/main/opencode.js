/**
 * opencode.js — opencode CLI / 配置桥接
 * - 二进制解析（支持 npm shim → 真实 exe）
 * - 会话列表（session list，容错解析）
 * - attach 服务健康检查（HTTP）
 * - 项目 opencode.json 的 permission 块读写（保守 JSONC 剥离，失败绝不写盘）
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, readFile, writeFile, rename, rm, stat } from 'node:fs/promises'
import { join, isAbsolute, dirname } from 'node:path'

const EXE_RE =
  /(?:[A-Za-z]:[\\/][^\s"']*|%~dp0[\\/]+|\$basedir[\\/])node_modules[\\/]@opencode[\\/]cli[\\/]bin[\\/]opencode\.exe/i

/** 直接 execFile 执行（超时默认 45s：opencode CLI 在端口冲突等场景 ~20s 才失败） */
export function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    // opencode CLI 在服务端口冲突等场景下可能 ~20s 才失败，超时放宽到 45s
    execFile(file, args, { windowsHide: true, timeout: 45000, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** 经 cmd.exe 兜底执行：windowsVerbatimArguments 防止 node 二次转义引号 */
export function runShell(cmdline, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', cmdline],
      { windowsHide: true, timeout: 45000, windowsVerbatimArguments: true, maxBuffer: 10 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
      }
    )
  })
}

/** 从 npm shim（.ps1/.cmd）文本中提取真实 exe 路径；$basedir / %~dp0 以 shim 所在目录解析（纯路径推导，不做磁盘检查） */
export function exeFromShim(text, shimPath) {
  const m = String(text || '').match(EXE_RE)
  if (!m) return null
  const base = dirname(shimPath)
  return m[0].replace(/^(?:%~dp0|\$basedir)[\\/]+/i, base + '\\').replace(/\//g, '\\')
}

/**
 * 解析 opencode 可执行文件。
 * 返回 { path, direct }：direct=true 可直接 spawn（参数数组安全）；
 * direct=false 时 path 为 PATH 中的命令名，由调用方经 shell 兜底。
 */
export async function resolveBinary(configured) {
  const cfg = String(configured || '').trim()
  if (cfg && isAbsolute(cfg)) {
    return existsSync(cfg) ? { path: cfg, direct: true } : null
  }
  if (cfg && /\.(exe|cmd|bat|ps1)$/i.test(cfg)) {
    if (isAbsolute(cfg)) return existsSync(cfg) ? { path: cfg, direct: true } : null
  }
  if (process.platform === 'win32') {
    const { stdout } = await run('where.exe', ['opencode'])
    const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const line of lines) {
      if (/\.exe$/i.test(line) && existsSync(line)) return { path: line, direct: true }
    }
    for (const line of lines) {
      if (!/\.(ps1|cmd|bat)$/i.test(line) || !existsSync(line)) continue
      try {
        const exe = exeFromShim(await readFile(line, 'utf-8'), line)
        if (exe && existsSync(exe)) return { path: exe, direct: true }
      } catch {
        /* 读 shim 失败继续下一个候选 */
      }
    }
    if (lines.length) return { path: cfg || 'opencode', direct: false }
    return null
  }
  const { err } = await run('which', [cfg || 'opencode'])
  return err ? null : { path: cfg || 'opencode', direct: true }
}

/** run 子命令能力探测缓存（key = exe 路径） */
const runCapsCache = new Map()

/**
 * 探测 `opencode run` 是否支持 --attach（不同版本 flag 集不同，v2.1.x 已移除）。
 * 返回 { attach: boolean }；探测失败按不支持处理（保守，避免 run 直接报错）。
 */
export async function detectRunFlags(bin) {
  if (!bin) return { attach: false }
  const key = bin.path
  if (runCapsCache.has(key)) return runCapsCache.get(key)
  const args = ['run', '--help']
  const r = bin.direct
    ? await run(bin.path, args, { timeout: 20000 })
    : await runShell(cmdQuote(bin.path, args), { timeout: 20000 })
  const text = `${r.stdout}\n${r.stderr}`
  const caps = { attach: text.includes('--attach') }
  runCapsCache.set(key, caps)
  return caps
}

/** 解析 models 命令文本输出：提取形如 provider/model 的 token（纯函数，可单测） */
export function parseModelsOutput(text) {
  const out = new Set()
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const token of line.split(/[\s|,;]+/)) {
      const t = token.trim()
      if (/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._#-]*$/i.test(t)) out.add(t)
    }
  }
  return [...out]
}

/** 从全局 opencode 配置的 provider 段推导模型候选（纯数据函数，可单测） */
export function modelsFromProviders(cfgData) {
  const out = []
  const providers = cfgData?.provider && typeof cfgData.provider === 'object' ? cfgData.provider : {}
  for (const [provider, p] of Object.entries(providers)) {
    const models = p?.models && typeof p.models === 'object' ? Object.keys(p.models) : []
    for (const m of models) out.push(`${provider}/${m}`)
  }
  return [...new Set(out)]
}

/** 读取全局配置路径（Windows: %USERPROFILE%\.config\opencode\opencode.json[c]） */
export function globalConfigCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  if (!home) return []
  return [join(home, '.config', 'opencode', 'opencode.json'), join(home, '.config', 'opencode', 'opencode.jsonc')]
}

/** 模型候选聚合：全局配置推导优先，CLI 查询尽力合并 */
export async function listModels(bin) {
  const items = new Set()
  const sources = []
  for (const file of globalConfigCandidates()) {
    if (!existsSync(file)) continue
    try {
      const raw = await readFile(file, 'utf-8')
      let data
      try {
        data = JSON.parse(raw)
      } catch {
        data = JSON.parse(stripJsonComments(raw))
      }
      for (const m of modelsFromProviders(data)) items.add(m)
      sources.push('全局配置')
      break
    } catch {
      /* 单个文件解析失败忽略 */
    }
  }
  if (bin) {
    const args = ['models']
    const r = bin.direct
      ? await run(bin.path, args, { timeout: 20000 })
      : await runShell(cmdQuote(bin.path, args), { timeout: 20000 })
    const parsed = parseModelsOutput(r.stdout)
    for (const m of parsed) items.add(m)
    if (parsed.length) sources.push('CLI 查询')
  }
  return { ok: items.size > 0, items: [...items], sources: [...new Set(sources)], error: items.size ? '' : '未获取到模型候选，可手动输入（格式 provider/model）' }
}

// ---------- opencode v2 本地 API（Basic 认证，凭据来自 service.json） ----------

const serviceJsonPath = () =>
  join(process.env.USERPROFILE || process.env.HOME || '', '.local', 'state', 'opencode', 'service.json')

let apiAuthCache = { mtime: 0, auth: null }

/** 读取本地服务凭据（service.json：url + password），按 mtime 缓存 */
export async function readServiceAuth() {
  const file = serviceJsonPath()
  try {
    const st = await stat(file)
    if (apiAuthCache.auth && apiAuthCache.mtime === st.mtimeMs) return apiAuthCache.auth
    const data = JSON.parse(await readFile(file, 'utf-8'))
    if (!data?.url || !data?.password) return null
    const auth = {
      url: String(data.url).replace(/\/+$/, ''),
      header: 'Basic ' + Buffer.from(`opencode:${data.password}`).toString('base64')
    }
    apiAuthCache = { mtime: st.mtimeMs, auth }
    return auth
  } catch {
    return null
  }
}

/** 调用本地 API；返回 { ok, data } 或 { ok:false, error } */
export async function apiRequest(path, { timeout = 8000 } = {}) {
  const auth = await readServiceAuth()
  if (!auth) return { ok: false, error: '未找到 opencode 服务凭据（service.json）' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(auth.url + path, { headers: { Authorization: auth.header }, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    try {
      return { ok: true, data: JSON.parse(text) }
    } catch {
      return { ok: false, error: '响应非 JSON' }
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带认证的 JSON API 请求（支持请求体、超时与外部取消）。
 * 返回 { ok, status, data, error, aborted }：aborted 表示被调用方的 signal 取消。
 */
async function apiFetch(path, { method = 'GET', body, timeout = 8000, signal } = {}) {
  const auth = await readServiceAuth()
  if (!auth) return { ok: false, error: '未找到 opencode 服务凭据（service.json）' }
  if (signal?.aborted) return { ok: false, aborted: true, error: '已取消' }
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(auth.url + path, {
      method,
      headers: {
        Authorization: auth.header,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal
    })
    const text = await res.text()
    let data = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: data?.message || `HTTP ${res.status}` }
    }
    return { ok: true, status: res.status, data }
  } catch (err) {
    const aborted = !!signal?.aborted
    return {
      ok: false,
      aborted,
      timeout: !aborted,
      error: aborted ? '已取消' : String(err?.message || err)
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 归一化会话状态探测结果（纯函数，可单测） */
export function normalizeSessionProbe(sessionId, activeMap, info, inbox) {
  return {
    active: !!(activeMap && activeMap[sessionId]),
    inbox: Array.isArray(inbox) ? inbox.length : 0,
    outcome: String(info?.outcome || ''),
    idleAt: Number(info?.time?.idle) || 0,
    updatedAt: Number(info?.time?.updated) || 0
  }
}

/**
 * 探测指定会话的真实状态：
 * - `GET /api/session/active`：权威的“正在执行”标记（不在结果中即空闲）
 * - `GET /api/session/{id}/inbox`：尚未投递的排队消息
 * - `GET /api/session/{id}`：上次执行结果与空闲时间（仅用于展示/日志）
 * outcome/time.idle 在运行期间仍是上一次的值，不能单独用于判断忙碌。
 */
export async function probeSession(sessionId) {
  if (!sessionId) return { ok: false, error: '缺少会话 ID' }
  const sid = encodeURIComponent(sessionId)
  const [active, info, inbox] = await Promise.all([
    apiRequest('/api/session/active'),
    apiRequest(`/api/session/${sid}`),
    apiRequest(`/api/session/${sid}/inbox`)
  ])
  if (!active.ok) return { ok: false, error: active.error || '会话状态不可用' }
  const p = normalizeSessionProbe(
    sessionId,
    active.data?.data,
    info.ok ? info.data?.data : null,
    inbox.ok ? inbox.data?.data : []
  )
  return { ok: true, ...p, inboxKnown: inbox.ok, error: '' }
}

/** 等待会话 agent loop 空闲（长轮询：204 = 已空闲；503 = 服务暂不可用） */
export async function waitSessionIdle(sessionId, { timeoutMs = 60000, signal } = {}) {
  if (!sessionId) return { ok: false, error: '缺少会话 ID' }
  const r = await apiFetch(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, {
    method: 'POST',
    timeout: timeoutMs,
    signal
  })
  return r.ok ? { ok: true } : r
}

/** 中断会话服务器端执行（只影响当前 active drain；无执行时 interrupted=false） */
export async function interruptSession(sessionId) {
  if (!sessionId) return { ok: false, error: '缺少会话 ID' }
  const r = await apiFetch(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, interrupted: !!r.data?.interrupted }
}

/** 归一化 API 会话对象（纯函数，可单测） */
export function normalizeApiSession(s) {
  return {
    id: String(s?.id || ''),
    title: String(s?.title || ''),
    projectID: String(s?.projectID || ''),
    dir: String(s?.location?.directory || s?.subpath || ''),
    created: s?.time?.created || null,
    updated: s?.time?.updated || null,
    model: s?.model?.providerID && s?.model?.id ? `${s.model.providerID}/${s.model.id}` : '',
    outcome: String(s?.outcome || '')
  }
}

const normDir = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 全局历史会话（API）：所有项目的真实标题会话，按更新时间倒序 */
export async function apiHistorySessions() {
  const [sessions, projects] = await Promise.all([apiRequest('/api/session'), apiRequest('/api/project')])
  if (!sessions.ok) return { ok: false, error: sessions.error }
  const projectMap = new Map()
  if (projects.ok && Array.isArray(projects.data)) {
    for (const p of projects.data) projectMap.set(p.id, p.canonical || '')
  }
  const rows = (sessions.data?.data || [])
    .map(normalizeApiSession)
    .map((s) => {
      const dir = s.dir || projectMap.get(s.projectID) || ''
      const projectName = dir.split(/[\\/]/).filter(Boolean).pop() || ''
      return { ...s, dir, projectName }
    })
    .filter((s) => s.id)
  rows.sort((a, b) => (b.updated || 0) - (a.updated || 0))
  return { ok: true, rows, total: rows.length }
}

/**
 * 指定项目目录下的会话（API）：优先按项目 ID（与 TUI 分组口径一致），
 * 无匹配项目时回退按目录前缀过滤；按更新时间倒序（首条即 -c 续写目标）。
 */
export async function apiSessionsForDir(dir) {
  const [sessions, projects] = await Promise.all([apiRequest('/api/session'), apiRequest('/api/project')])
  if (!sessions.ok) return { ok: false, error: sessions.error }
  const base = normDir(dir)
  const projList = projects.ok && Array.isArray(projects.data) ? projects.data : []
  // 任务目录 → opencode 项目（canonical 相等或其子目录）
  const proj = projList.find((p) => {
    const c = normDir(p.canonical)
    return c && (c === base || base.startsWith(c + '\\'))
  })
  const rows = (sessions.data?.data || [])
    .map(normalizeApiSession)
    .map((s) => ({
      ...s,
      projectName: s.dir.split(/[\\/]/).filter(Boolean).pop() || ''
    }))
    .filter((s) => s.id)
  const filtered = proj
    ? rows.filter((s) => s.projectID === proj.id)
    : rows.filter((s) => {
        const d = normDir(s.dir)
        return d === base || d.startsWith(base + '\\')
      })
  filtered.sort((a, b) => (b.updated || 0) - (a.updated || 0))
  return {
    ok: true,
    rows: filtered,
    total: filtered.length,
    projectId: proj?.id || '',
    canonical: proj?.canonical || ''
  }
}

/** 会话实际使用的模型：API 优先，export 兜底 */
export async function sessionModelById(sessionId, project, bin) {
  if (!sessionId) return ''
  const r = await apiRequest('/api/session')
  if (r.ok) {
    const s = (r.data?.data || []).find((x) => x.id === sessionId)
    const m = s?.model
    if (m?.providerID && m?.id) return `${m.providerID}/${m.id}`
  }
  return exportSessionModel(project, bin, sessionId)
}

/** 删除会话：API DELETE 优先，CLI `session delete` 兜底 */
export async function deleteSession(project, bin, sessionId) {
  if (!sessionId) return { ok: false, error: '缺少会话 ID' }
  const auth = await readServiceAuth()
  if (auth) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(`${auth.url}/api/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: { Authorization: auth.header },
        signal: ctrl.signal
      })
      clearTimeout(timer)
      if (res.ok || res.status === 204 || res.status === 404) return { ok: true, via: 'api' }
    } catch {
      /* 回退 CLI */
    }
  }
  if (!project) return { ok: false, error: '缺少项目目录，无法回退 CLI 删除' }
  const args = ['session', 'delete', sessionId]
  const r = bin?.direct
    ? await run(bin.path, args, { cwd: project, timeout: 20000 })
    : await runShell(cmdQuote(bin?.path || 'opencode', args), { cwd: project, timeout: 20000 })
  if (r.err && !r.stdout.trim()) {
    return { ok: false, error: firstLineOfSafe(r.stderr) || String(r.err?.message || r.err || '删除失败') }
  }
  return { ok: true, via: 'cli' }
}

function firstLineOfSafe(text) {
  return String(text || '').trim().split(/\r?\n/)[0] || ''
}

/** 解析 `opencode session list` 输出：优先 JSON，退化为逐行正则提取会话 id */export function parseSessionList(text) {
  const raw = String(text || '')
  const trimmed = raw.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed)
      const arr = Array.isArray(j) ? j : Array.isArray(j.sessions) ? j.sessions : null
      if (arr) {
        const list = arr
          .map((s) => ({
            id: String(s.id ?? s.sessionId ?? s.sessionID ?? ''),
            title: String(s.title ?? s.name ?? '').slice(0, 120),
            updatedAt: s.updatedAt ?? s.time?.updated ?? s.updated ?? null
          }))
          .filter((s) => s.id)
        if (list.length) return list
      }
    } catch {
      /* 非纯 JSON，走行解析 */
    }
  }
  const out = []
  const seen = new Set()
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[0-9a-zA-Z]+|[0-9a-f]{16,})/i
    )
    if (!m) continue
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    const title = line.replace(id, '').replace(/[|`]/g, ' ').trim().slice(0, 120)
    out.push({ id, title, updatedAt: null })
  }
  return out
}

/** 从 session export JSON 中解析最后一条 assistant 消息使用的模型（纯函数，可单测） */
export function parseSessionModel(jsonText) {
  const raw = String(jsonText || '')
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    // 大输出/异常时用正则兜底：取最后一个 assistant 消息的 model 块
    const re = /"type"\s*:\s*"assistant"[\s\S]*?"model"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"providerID"\s*:\s*"([^"]+)"/g
    let m
    let last = null
    while ((m = re.exec(raw))) last = m
    return last ? `${last[2]}/${last[1]}` : ''
  }
  const messages = Array.isArray(data?.messages) ? data.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type !== 'assistant') continue
    const id = msg.model?.id
    const provider = msg.model?.providerID
    if (id && provider) return `${provider}/${id}`
    if (id) return String(id)
  }
  return ''
}

/** 查询某会话实际使用的模型（export 一次，失败静默返回空串） */
export async function exportSessionModel(project, bin, sessionId) {
  if (!project || !sessionId) return ''
  const args = ['session', 'export', sessionId]
  const r = bin?.direct
    ? await run(bin.path, args, { cwd: project, timeout: 20000, maxBuffer: 32 * 1024 * 1024 })
    : await runShell(cmdQuote(bin?.path || 'opencode', args), { cwd: project, timeout: 20000, maxBuffer: 32 * 1024 * 1024 })
  if (!r.stdout.trim()) return ''
  return parseSessionModel(r.stdout)
}

/** 批量扫描多个项目的会话（串行，避免并发争抢 managed service） */
export async function listSessionsForProjects(projects, bin) {
  const unique = [...new Set((projects || []).map((p) => String(p || '').trim()).filter(Boolean))]
  const groups = []
  for (const project of unique) {
    const r = await listSessions(project, bin)
    groups.push({ project, ok: r.ok, sessions: (r.sessions || []).slice(0, 50), error: r.error || '' })
  }
  const total = groups.reduce((n, g) => n + g.sessions.length, 0)
  return { groups, total, scanned: unique.length }
}

/** 在项目目录执行 session list，返回 { ok, sessions, raw, error } */
export async function listSessions(project, bin) {
  if (!project) return { ok: false, sessions: [], raw: '', error: '未配置项目目录' }
  const args = ['session', 'list']
  const r = bin?.direct
    ? await run(bin.path, args, { cwd: project })
    : await runShell(cmdQuote(bin?.path || 'opencode', args), { cwd: project })
  if (r.err && !r.stdout.trim()) {
    return { ok: false, sessions: [], raw: (r.stderr || r.err.message), error: 'session list 失败' }
  }
  const sessions = parseSessionList(r.stdout)
  return { ok: true, sessions, raw: r.stdout, error: sessions.length ? '' : '未解析到会话，查看原始输出' }
}

/** cmd.exe 命令行拼接（"" 转义内嵌引号） */
export function cmdQuote(file, args) {
  const q = (s) => (/\s/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s).replace(/"/g, '""'))
  return [file, ...args].map(q).join(' ')
}

/** attach 服务健康检查：任意 HTTP 响应视为在线 */
export async function checkAttach(url) {
  if (!url) return { ok: false, message: '未配置 attach 地址' }
  const started = Date.now()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3500)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    return { ok: true, status: res.status, ms: Date.now() - started }
  } catch (err) {
    return { ok: false, message: String(err?.cause?.code || err?.message || err), ms: Date.now() - started }
  }
}

// ---------- 项目配置（opencode.json / opencode.jsonc）的权限块读写 ----------

export function configCandidates(project) {
  return [join(project, 'opencode.json'), join(project, 'opencode.jsonc')]
}

/** 保守 JSONC 剥离：状态机逐字符扫描，字符串内的 // 与 /* 不误伤 */
export function stripJsonComments(text) {
  const src = String(text)
  let out = ''
  let i = 0
  let inStr = false
  while (i < src.length) {
    const c = src[i]
    if (inStr) {
      out += c
      if (c === '\\' && i + 1 < src.length) {
        out += src[i + 1]
        i += 2
        continue
      }
      if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  // 宽松去除尾逗号（],} 前的逗号，仅限重复空白场景）
  return out.replace(/,(\s*[}\]])/g, '$1')
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 读取项目配置：优先 opencode.json；仅有 .jsonc 时也作为目标。
 * 返回 { file, exists, data?, parseError? }
 */
export async function readProjectConfig(project) {
  const [jsonPath, jsoncPath] = configCandidates(project)
  const file = (await exists(jsonPath)) ? jsonPath : (await exists(jsoncPath)) ? jsoncPath : jsonPath
  const target = (await exists(file)) ? file : null
  if (!target) return { file, exists: false }
  try {
    const raw = await readFile(target, 'utf-8')
    try {
      return { file: target, exists: true, data: JSON.parse(raw) }
    } catch {
      const data = JSON.parse(stripJsonComments(raw))
      return { file: target, exists: true, data }
    }
  } catch (err) {
    return { file: target, exists: true, parseError: String(err?.message || err) }
  }
}

export const PERMISSION_LEVELS = ['allow', 'ask', 'deny']

/** 归一化权限块：仅保留合法结构（edit/webfetch 为三级值；bash 为 pattern→三级值） */
export function normalizePermission(input) {
  const val = (v) => (PERMISSION_LEVELS.includes(v) ? v : undefined)
  const out = {}
  const e = val(input?.edit)
  if (e) out.edit = e
  const w = val(input?.webfetch)
  if (w) out.webfetch = w
  if (input?.bash && typeof input.bash === 'object') {
    const bash = {}
    for (const [k, v] of Object.entries(input.bash)) {
      const key = String(k).trim()
      const bv = val(v)
      if (key && bv) bash[key] = bv
    }
    if (Object.keys(bash).length) out.bash = bash
  }
  return out
}

/** 写回权限块：保留配置其余键；临时文件 + rename 原子写盘。解析失败时抛错（绝不覆盖） */
export async function writeProjectPermission(project, permission) {
  if (!project) throw new Error('未配置项目目录')
  const cfg = await readProjectConfig(project)
  if (cfg.parseError) {
    throw new Error(`配置文件解析失败，拒绝写入：${cfg.parseError}`)
  }
  const next = { ...(cfg.data || {}), permission: normalizePermission(permission) }
  await atomicWrite(cfg.file, JSON.stringify(next, null, 2) + '\n')
  return { file: cfg.file, permission: next.permission }
}

/** 生成 ~/.local/share 等价目录无关的原子写（导出给 main 使用） */
export async function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** 便于诊断：where/which 结果原样返回 */
export async function diagnoseBinary(configured) {
  if (process.platform === 'win32') {
    const r = await run('where.exe', ['opencode'])
    return { tool: 'where', stdout: r.stdout, stderr: r.stderr, resolved: await resolveBinary(configured) }
  }
  const r = await run('which', [configured || 'opencode'])
  return { tool: 'which', stdout: r.stdout, stderr: r.stderr, resolved: await resolveBinary(configured) }
}
