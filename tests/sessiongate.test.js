import { describe, expect, it } from 'vitest'
import {
  WAIT_LIMIT_DEFAULT_MIN,
  waitLimitMs,
  timeoutAction,
  sessionBusy,
  busyReason,
  outcomeText,
  SessionLease
} from '../src/main/sessiongate.js'

describe('waitLimitMs（会话等待上限）', () => {
  it('默认 30 分钟；0/负数/非法值 = 不限制', () => {
    expect(WAIT_LIMIT_DEFAULT_MIN).toBe(30)
    expect(waitLimitMs({})).toBe(30 * 60 * 1000)
    expect(waitLimitMs({ sessionWaitLimitMin: 0 })).toBe(0)
    expect(waitLimitMs({ sessionWaitLimitMin: -5 })).toBe(0)
    expect(waitLimitMs({ sessionWaitLimitMin: 'abc' })).toBe(30 * 60 * 1000)
    expect(waitLimitMs({ sessionWaitLimitMin: 45 })).toBe(45 * 60 * 1000)
    expect(waitLimitMs({ sessionWaitLimitMin: 0.5 })).toBe(30 * 1000)
  })
})

describe('timeoutAction（等待超时处置）', () => {
  it('默认/非法值回退 send；仅 stop 生效', () => {
    expect(timeoutAction({})).toBe('send')
    expect(timeoutAction({ sessionWaitTimeoutAction: 'send' })).toBe('send')
    expect(timeoutAction({ sessionWaitTimeoutAction: 'bogus' })).toBe('send')
    expect(timeoutAction({ sessionWaitTimeoutAction: null })).toBe('send')
    expect(timeoutAction({ sessionWaitTimeoutAction: 'stop' })).toBe('stop')
  })
})

describe('sessionBusy / busyReason', () => {
  it('运行中或排队消息都算忙，并给出可读原因', () => {
    expect(sessionBusy({ active: true, inbox: 0 })).toBe(true)
    expect(sessionBusy({ active: false, inbox: 2 })).toBe(true)
    expect(sessionBusy({ active: false, inbox: 0 })).toBe(false)
    expect(sessionBusy(null)).toBe(false)

    expect(busyReason({ active: true, inbox: 0 })).toContain('运行')
    expect(busyReason({ active: false, inbox: 3 })).toContain('3 条排队消息')
    expect(busyReason({ active: true, inbox: 3 })).toContain('运行')
    expect(busyReason({ active: true, inbox: 3 })).toContain('3 条排队消息')
    expect(busyReason({ active: false, inbox: 0 })).toBe('')
  })

  it('执行结果文案', () => {
    expect(outcomeText('succeeded')).toBe('成功')
    expect(outcomeText('failed')).toBe('失败')
    expect(outcomeText('interrupted')).toBe('已中断')
    expect(outcomeText('')).toBe('未知')
  })
})

describe('SessionLease（同一会话单写者）', () => {
  it('同一任务可重复获取；其他任务被拒绝，释放后可获取', () => {
    const lease = new SessionLease()
    expect(lease.acquire('ses_a', 't1')).toEqual({ ok: true })
    expect(lease.acquire('ses_a', 't1')).toEqual({ ok: true })
    const busy = lease.acquire('ses_a', 't2')
    expect(busy.ok).toBe(false)
    expect(busy.owner).toBe('t1')
    expect(lease.owner('ses_a')).toBe('t1')

    lease.release('ses_a', 't1')
    expect(lease.owner('ses_a')).toBe('')
    expect(lease.acquire('ses_a', 't2')).toEqual({ ok: true })
  })

  it('不同会话互不影响；空参数视为无租约', () => {
    const lease = new SessionLease()
    expect(lease.acquire('ses_a', 't1').ok).toBe(true)
    expect(lease.acquire('ses_b', 't2').ok).toBe(true)
    expect(lease.acquire('', 't1').ok).toBe(true)
    expect(lease.acquire('ses_c', '').ok).toBe(true)
    lease.release('ses_a', 't2')
    expect(lease.owner('ses_a')).toBe('t1')
    lease.clear()
    expect(lease.owner('ses_a')).toBe('')
  })
})
