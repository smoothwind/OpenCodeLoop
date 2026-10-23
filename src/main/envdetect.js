/**
 * envdetect.js — 环境依赖检测（opencode / node / npm / git 的位置与版本）
 * 复用 opencode.js 的二进制解析与 shell 兜底；纯解析函数可单测。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveBinary, run, runShell, cmdQuote } from './opencode.js'

const FAST = { timeout: 8000 }

/** 解析 where/which 输出为候选路径数组（纯函数） */
export function parseWhereOutput(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 取多行文本首行（纯函数） */
export function firstLineOf(text) {
  const t = String(text || '').trim()
  return t ? t.split(/\r?\n/)[0].trim() : ''
}

/** 从 opencode.exe 绝对路径推导 npm 全局根目录（纯函数；非该布局返回 null） */
export function opencodeGlobalRoot(exePath) {
  const m = String(exePath || '').match(
    /^(.*)[\\/]node_modules[\\/]@opencode[\\/]cli[\\/]bin[\\/]opencode\.exe/i
  )
  return m ? m[1] : null
}

async function locate(name) {
  if (process.platform === 'win32') {
    const r = await run('where.exe', [name], FAST)
    return parseWhereOutput(r.stdout)
  }
  const r = await run('which', [name], FAST)
  return parseWhereOutput(r.stdout)
}

/** 取版本：.exe 直接执行；.cmd/.bat/无后缀走 cmd 兜底（Windows 下 node 不允许直接 spawn .cmd） */
async function versionOf(cmdPath, args = ['--version']) {
  const isExe = /\.exe$/i.test(cmdPath)
  const r = isExe ? await run(cmdPath, args, FAST) : await runShell(cmdQuote(cmdPath, args), FAST)
  if (r.err && !r.stdout.trim()) {
    return { version: '', error: firstLineOf(r.stderr) || String(r.err.message || '') }
  }
  return { version: firstLineOf(r.stdout) || firstLineOf(r.stderr) }
}

export async function detectOpencode(configured) {
  const info = { key: 'opencode', name: 'OpenCode CLI', ok: false, path: '', version: '', detail: '', error: '' }
  const bin = await resolveBinary(configured)
  if (!bin) {
    info.error = '未在 PATH 找到 opencode；可 npm i -g @opencode/cli，或在下方指定完整 exe 路径'
    return info
  }
  info.ok = true
  info.path = bin.path
  if (!bin.direct) info.detail = '经 shell 兜底调用（未解析到真实 exe）'
  const v = await versionOf(bin.path, ['--version'])
  info.version = v.version
  if (v.error && !info.detail) info.error = v.error
  const root = opencodeGlobalRoot(bin.path)
  if (root) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'node_modules', '@opencode', 'cli', 'package.json'), 'utf-8'))
      info.version = info.version || pkg.version || ''
      info.detail = `npm 全局包 @opencode/cli@${pkg.version || '?'} · 安装目录 ${root}`
    } catch {
      info.detail = `npm 全局目录：${root}`
    }
  }
  return info
}

async function detectSimple(key, name, missHint) {
  const candidates = await locate(key)
  // Windows 候选优先级：exe > cmd/bat（npm 只有 .cmd 可用，无扩展名首行是 sh 包装）
  const path =
    candidates.find((c) => /\.exe$/i.test(c)) ||
    candidates.find((c) => /\.(cmd|bat)$/i.test(c)) ||
    candidates[0] ||
    ''
  const info = { key, name, ok: !!path, path, version: '', detail: '', error: '' }
  if (!path) {
    info.error = missHint
    return info
  }
  const v = await versionOf(path)
  info.version = v.version
  info.error = v.error
  return info
}

export function detectNode() {
  return detectSimple('node', 'Node.js', '未找到 node（opencode CLI 依赖 Node 运行时）')
}

export function detectNpm() {
  return detectSimple('npm', 'npm', '未找到 npm（用于安装/升级 @opencode/cli）')
}

export function detectGit() {
  return detectSimple('git', 'Git', '未找到 git（守护提示词约定「自动提交」需要它）')
}

export async function detectEnvironment(configuredOpencode) {
  const items = await Promise.all([
    detectOpencode(configuredOpencode),
    detectNode(),
    detectNpm(),
    detectGit()
  ])
  return { items, detectedAt: Date.now() }
}
