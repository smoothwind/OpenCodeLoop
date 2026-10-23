/**
 * attachctl.js — attach 服务重启控制
 * 流程：定位端口监听进程 → 校验是 opencode 才终止 → 拉起 opencode serve → 轮询健康检查
 */
import { spawn } from 'node:child_process'
import { run, cmdQuote, readServiceAuth } from './opencode.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 修复托管服务端口冲突：45278 被僵死的 opencode 服务占用时，
 * 结束该进程让下一个 CLI 实例重新拉起健康服务。
 * 仅终止进程名为 opencode 的监听者（pid 复用/其他程序一律拒绝）。
 */
export async function repairServiceConflict(port) {
  const listener = await getListener(port)
  if (!listener) return { ok: false, reason: 'none' }
  if (!/^opencode/i.test(listener.name)) {
    return { ok: false, reason: 'not-opencode', name: listener.name, pid: listener.pid }
  }
  await killTree(listener.pid)
  await sleep(1200)
  return { ok: true, pid: listener.pid, name: listener.name }
}

/** 解析 attach URL → { port, hostname, healthUrl }（纯函数，可单测） */
export function parseAttachTarget(url) {
  let u
  try {
    u = new URL(String(url || ''))
  } catch {
    return { error: 'attach 地址无效：' + url }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: 'attach 地址必须是 http(s)：' + url }
  }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  const hostname = /localhost/i.test(u.hostname) ? '127.0.0.1' : u.hostname
  return { port, hostname, healthUrl: url }
}

/** 查询端口监听进程 → { pid, name } | null（仅 Windows） */
export async function getListener(port) {
  if (process.platform !== 'win32') return null
  const cmd =
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; ("{0}|{1}" -f $c.OwningProcess, $p.ProcessName) } else { 'NONE' }`
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 10000 })
  const line = String(r.stdout || '').trim().split(/\r?\n/).pop() || ''
  if (!line || line === 'NONE') return null
  const sep = line.lastIndexOf('|')
  if (sep < 0) return null
  const pid = Number(line.slice(0, sep))
  if (!Number.isFinite(pid)) return null
  return { pid, name: line.slice(sep + 1) || 'unknown' }
}

/** 终止进程树（Windows taskkill /T /F） */
export function killTree(pid) {
  return new Promise((resolve) => {
    const c = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    c.on('exit', () => resolve())
    c.on('error', () => resolve())
  })
}

/** 拉起 opencode serve（detached，脱离应用生命周期独立运行） */
export function startServe(bin, port, hostname) {
  const args = ['serve', '--port', String(port), '--hostname', hostname]
  let child
  if (bin?.direct) {
    child = spawn(bin.path, args, { windowsHide: true, detached: true, stdio: 'ignore' })
  } else {
    child = spawn('cmd.exe', ['/d', '/s', '/c', cmdQuote(bin?.path || 'opencode', args)], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    })
  }
  child.unref()
  return child.pid ?? null
}

/** 轮询健康检查直到可达或超时 */
export async function waitForHealth(url, timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      const res = await fetch(url, { signal: ctrl.signal })
      clearTimeout(timer)
      return { ok: true, ms: Date.now() - t0, status: res.status }
    } catch {
      /* 未就绪继续等 */
    }
    await sleep(800)
  }
  return { ok: false, ms: Date.now() - t0 }
}

/**
 * 重启 attach 服务编排：
 * 1) 端口被占用且进程是 opencode → 结束；非 opencode → 拒绝（避免误杀）
 * 2) 拉起 opencode serve --port --hostname
 * 3) 轮询健康检查
 */
export async function restartAttach({ url, bin }) {
  const target = parseAttachTarget(url)
  if (target.error) return { ok: false, message: target.error }
  const { port, hostname } = target

  // 安全护栏：托管服务端口被所有运行中的守护共用，重启会中断全部任务
  try {
    const auth = await readServiceAuth()
    if (auth) {
      const managedPort = Number(new URL(auth.url).port) || 80
      if (port === managedPort) {
        return {
          ok: false,
          message: `端口 ${port} 是 opencode 托管服务端口（所有守护共用），重启会中断正在运行的任务，已拒绝操作`
        }
      }
    }
  } catch {
    /* 凭据不可读时跳过护栏 */
  }

  let killedPid = null
  const listener = await getListener(port)
  if (listener) {
    if (!/^opencode/i.test(listener.name)) {
      return {
        ok: false,
        message: `端口 ${port} 被 ${listener.name}（pid ${listener.pid}）占用且不是 opencode，已取消自动重启`
      }
    }
    await killTree(listener.pid)
    killedPid = listener.pid
    await sleep(800)
  }

  const servePid = startServe(bin, port, hostname)
  const health = await waitForHealth(url, 25000)
  if (!health.ok) {
    return {
      ok: false,
      message: `opencode serve 已拉起（pid ${servePid ?? '?'}），但 25 秒内未通过健康检查，请查看其输出`,
      killedPid,
      servePid
    }
  }
  return { ok: true, killedPid, servePid, ms: health.ms, restarted: killedPid != null }
}
