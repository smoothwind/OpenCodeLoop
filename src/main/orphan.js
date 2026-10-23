/**
 * orphan.js — 孤儿守护进程看护
 * 应用异常退出时守护子进程会残留；运行期把存活 pid 记录到 orphans.json，
 * 下次启动读取并对其中仍存活的 opencode 进程执行进程树终止。
 */
import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { run } from './opencode.js'
import { killTree } from './attachctl.js'

export function readOrphans(file) {
  return readFile(file, 'utf-8')
    .then((raw) => {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((o) => Number.isFinite(o?.pid)) : []
    })
    .catch(() => [])
}

/** 写盘串行化：多个任务的状态事件可能并发写快照 */
let orphanWriteChain = Promise.resolve()

export function writeOrphans(file, list) {
  orphanWriteChain = orphanWriteChain
    .catch(() => {})
    .then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      await mkdir(dirname(file), { recursive: true }).catch(() => {})
      await writeFile(tmp, JSON.stringify(list), 'utf-8')
      await rename(tmp, file)
    })
    .catch(() => {
      /* 快照写失败不影响守护 */
    })
  return orphanWriteChain
}

/** 查询进程名（Windows tasklist CSV；非 Windows / 不存在返回 null） */
export async function processName(pid) {
  if (process.platform !== 'win32') return null
  const r = await run(
    'tasklist',
    ['/fi', `PID eq ${Number(pid)}`, '/fo', 'csv', '/nh'],
    { timeout: 8000 }
  )
  const line = String(r.stdout || '').trim().split(/\r?\n/)[0] || ''
  if (!line || /信息|INFO:/.test(line)) return null
  const m = line.match(/"([^"]+)"\s*,\s*"(\d+)"/)
  return m ? m[1] : null
}

/**
 * 清理孤儿：仅终止进程名以 opencode 开头的残留进程（pid 被复用时不会误杀）。
 * 返回被清理的条目列表。
 */
export async function reapOrphans(file, { onLog } = {}) {
  const list = await readOrphans(file)
  if (!list.length) {
    writeOrphans(file, []).catch(() => {})
    return []
  }
  const reaped = []
  for (const o of list) {
    try {
      const name = await processName(o.pid)
      if (name && /^opencode/i.test(name)) {
        await killTree(o.pid)
        reaped.push({ ...o, name })
        onLog?.(`清理孤儿守护进程 ${name}（pid ${o.pid}，任务「${o.taskName || '?'}」）`)
      }
    } catch {
      /* 单个失败跳过 */
    }
  }
  await writeOrphans(file, [])
  return reaped
}

/** 运行期维护存活快照：daemonStates 为 taskId → state 映射 */
export function runningList(daemonStates, taskNameOf) {
  const out = []
  for (const [taskId, st] of Object.entries(daemonStates || {})) {
    if ((st.status === 'running' || st.status === 'waiting') && st.pid) {
      out.push({ pid: st.pid, taskId, taskName: taskNameOf(taskId), startedAt: st.roundStartedAt || st.startedAt })
    }
  }
  return out
}
