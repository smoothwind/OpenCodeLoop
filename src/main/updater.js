/**
 * updater.js — 更新检测（只提醒，不下载）
 *
 * 更新源：GitHub Releases。owner/repo 优先读取打包时生成的
 * `resources/app-update.yml`（electron-builder），缺省用内置常量。
 *
 * 仅查询 latest release 的元数据并与当前版本比较；绝不下载安装包，
 * 是否升级由用户自行前往发布页处理。
 */

/** 默认更新源（app-update.yml 不可读时的兜底） */
export const DEFAULT_FEED = { owner: 'smoothwind', repo: 'OpenCodeLoop' }

/** 解析 app-update.yml（electron-builder 生成）：仅接受 github provider */
export function feedFromAppUpdateYml(text) {
  const t = String(text || '')
  if (!t.trim()) return null
  const owner = /^owner:\s*(\S+)\s*$/m.exec(t)?.[1]
  const repo = /^repo:\s*(\S+)\s*$/m.exec(t)?.[1]
  const provider = /^provider:\s*(\S+)\s*$/m.exec(t)?.[1]
  if (!owner || !repo) return null
  if (provider && provider !== 'github') return null
  return { owner, repo }
}

/** GitHub Releases latest 查询地址 */
export function githubLatestUrl(feed) {
  if (!feed?.owner || !feed?.repo) return ''
  return `https://api.github.com/repos/${feed.owner}/${feed.repo}/releases/latest`
}

/** 解析 semver 标签（允许 v 前缀 / 预发布后缀）；非法返回 null */
export function parseSemver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(tag || '').trim()
  )
  if (!m) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null }
}

/**
 * semver 比较：a > b → 1，a < b → -1，相等 → 0。
 * 预发布版本低于同版本号的正式版（semver 规范）；无法解析的输入返回 0。
 */
export function compareSemver(a, b) {
  const x = parseSemver(a)
  const y = parseSemver(b)
  if (!x || !y) return 0
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1
  }
  if (!x.pre && !y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p1 = xs[i]
    const p2 = ys[i]
    if (p1 === undefined) return -1
    if (p2 === undefined) return 1
    const n1 = /^\d+$/.test(p1)
    const n2 = /^\d+$/.test(p2)
    if (n1 !== n2) return n1 ? -1 : 1 // 数字标识符低于字母标识符
    if (n1 && n2) {
      if (+p1 !== +p2) return +p1 > +p2 ? 1 : -1
    } else if (p1 !== p2) {
      return p1 > p2 ? 1 : -1
    }
  }
  return 0
}

/** GitHub release API 响应 → 展示信息（纯函数） */
export function normalizeRelease(data) {
  const v = parseSemver(data?.tag_name)
  return {
    version: v ? `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}` : '',
    tagName: String(data?.tag_name || ''),
    name: String(data?.name || data?.tag_name || ''),
    url: String(data?.html_url || ''),
    notes: String(data?.body || ''),
    publishedAt: data?.published_at || null
  }
}

/**
 * 检查更新：仅查询 latest release 元数据并比较版本，绝不下载。
 * 返回 { status: 'available'|'latest'|'none'|'error', current, version?, url?, notes?, error }
 */
export async function checkForUpdate({
  currentVersion,
  feed = DEFAULT_FEED,
  fetchImpl = fetch,
  timeoutMs = 8000
} = {}) {
  const current = parseSemver(currentVersion)
  if (!current) return { status: 'error', current: currentVersion, error: `当前版本号无法解析：${currentVersion}` }
  const url = githubLatestUrl(feed)
  if (!url) return { status: 'error', current: currentVersion, error: '未配置更新源（owner/repo）' }
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'OpenCodeLoop-UpdateCheck' },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (res.status === 404) {
      return { status: 'none', current: currentVersion, error: '更新源还没有发布版本' }
    }
    if (!res.ok) return { status: 'error', current: currentVersion, error: `HTTP ${res.status}` }
    const rel = normalizeRelease(await res.json())
    if (!rel.version) return { status: 'error', current: currentVersion, error: '更新源响应格式异常' }
    const newer = compareSemver(rel.version, currentVersion) > 0
    return { status: newer ? 'available' : 'latest', current: currentVersion, ...rel, error: '' }
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? '请求超时' : String(err?.message || err)
    return { status: 'error', current: currentVersion, error: msg }
  }
}
