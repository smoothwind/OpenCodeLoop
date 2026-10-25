/**
 * sessiongate.js — 会话级发送闸门（纯逻辑，可单测）
 *
 * 目标：守护进程在向指定会话投递提示词之前，先确认该会话没有被 TUI/其他客户端
 * 正在执行，也没有排队消息；否则 `opencode run` 会以 steer 方式插进正在运行的回合。
 *
 * 组成：
 * - waitLimitMs：任务配置的等待上限（分钟 → 毫秒，0 = 不限制，默认 30 分钟）
 * - sessionBusy / busyReason：判定“运行中 / 有排队消息”并生成日志文案
 * - SessionLease：同一会话在进程内只允许一个守护发送（防多任务共用会话时并发投递）
 */

/** 默认等待上限：30 分钟 */
export const WAIT_LIMIT_DEFAULT_MIN = 30

/** 任务配置 → 等待上限毫秒（<=0 = 不限制；缺省/非法值用默认 30 分钟） */
export function waitLimitMs(cfg) {
  const raw = cfg?.sessionWaitLimitMin
  const min = raw === undefined || raw === null || raw === '' ? WAIT_LIMIT_DEFAULT_MIN : Number(raw)
  if (!Number.isFinite(min)) return WAIT_LIMIT_DEFAULT_MIN * 60 * 1000
  if (min <= 0) return 0
  return Math.round(min * 60 * 1000)
}

/** 会话是否忙碌：agent loop 运行中，或仍有排队消息未投递 */
export function sessionBusy(probe) {
  if (!probe) return false
  return !!probe.active || Number(probe.inbox) > 0
}

/** 忙碌原因（日志/状态栏文案）；空闲返回空串 */
export function busyReason(probe) {
  if (!probe) return ''
  const n = Number(probe.inbox) || 0
  if (probe.active) {
    return n > 0
      ? `会话正在运行（TUI 或其他客户端），另有 ${n} 条排队消息`
      : '会话正在运行（TUI 或其他客户端）'
  }
  if (n > 0) return `会话有 ${n} 条排队消息`
  return ''
}

/** 会话执行结果 → 展示文案 */
export function outcomeText(outcome) {
  if (outcome === 'succeeded') return '成功'
  if (outcome === 'failed') return '失败'
  if (outcome === 'interrupted') return '已中断'
  return '未知'
}

/**
 * 进程内会话租约：sessionId → ownerId。
 * acquire 幂等（同一 owner 可重复获取），其他 owner 持有时返回 { ok:false, owner }。
 */
export class SessionLease {
  constructor() {
    this.owners = new Map()
  }

  acquire(sessionId, ownerId) {
    if (!sessionId || !ownerId) return { ok: true }
    const owner = this.owners.get(sessionId)
    if (!owner || owner === ownerId) {
      this.owners.set(sessionId, ownerId)
      return { ok: true }
    }
    return { ok: false, owner }
  }

  release(sessionId, ownerId) {
    if (!sessionId) return
    if (!ownerId || this.owners.get(sessionId) === ownerId) this.owners.delete(sessionId)
  }

  owner(sessionId) {
    return this.owners.get(sessionId) || ''
  }

  clear() {
    this.owners.clear()
  }
}
