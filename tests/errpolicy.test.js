import { describe, expect, it } from 'vitest'
import {
  classifyError,
  parseResetTime,
  planRecovery,
  cooldownUntil,
  MODEL_PROBE_MS,
  AUTH_PROBE_MS,
  KIND_TEXT,
  LIMIT_TEXT,
  formatWait,
  formatClock
} from '../src/main/errpolicy.js'

// 固定"当前时间"，避免用例随运行时刻漂移
const NOW = new Date('2026-10-24T12:00:00').getTime()

describe('parseResetTime（额度恢复时间解析）', () => {
  it('完整日期时间（本地）', () => {
    const t = parseResetTime('套餐额度已用尽，将于 2026-10-25 00:00 恢复', NOW)
    expect(t).toBe(new Date(2026, 9, 25, 0, 0, 0).getTime())
  })

  it('完整日期时间（UTC 标记按 UTC 换算）', () => {
    const t = parseResetTime('The quota will reset at 2026-10-24 13:00:00 UTC', NOW)
    expect(t).toBe(Date.UTC(2026, 9, 24, 13, 0, 0))
  })

  it('带上下文的时刻：已过去则顺延一天', () => {
    const past = parseResetTime('reset at 06:00', NOW)
    expect(past).toBe(new Date(2026, 9, 25, 6, 0, 0).getTime())
    const future = parseResetTime('额度恢复时间：20:30', NOW)
    expect(future).toBe(new Date(2026, 9, 24, 20, 30, 0).getTime())
  })

  it('12 小时制："resets 5pm" / "5:30 PM"', () => {
    expect(parseResetTime('Usage limit reached. Resets 5pm', NOW)).toBe(
      new Date(2026, 9, 24, 17, 0, 0).getTime()
    )
    expect(parseResetTime('resets at 5:30 PM', NOW)).toBe(new Date(2026, 9, 24, 17, 30, 0).getTime())
  })

  it('相对时长：英文 in/after 与中文 等待/后', () => {
    expect(parseResetTime('please try again in 20s', NOW)).toBe(NOW + 20 * 1000)
    expect(parseResetTime('retry after 2 minutes', NOW)).toBe(NOW + 120 * 1000)
    expect(parseResetTime('请等待 5 分钟后重试', NOW)).toBe(NOW + 300 * 1000)
    expect(parseResetTime('触发限流，等待 1 小时后恢复', NOW)).toBe(NOW + 3600 * 1000)
  })

  it('无时间信息返回 null', () => {
    expect(parseResetTime('You exceeded your current quota')).toBeNull()
    expect(parseResetTime('')).toBeNull()
  })
})

describe('classifyError（错误分类）', () => {
  it('额度不足（中文）带恢复时间', () => {
    const r = classifyError('您的套餐额度已用尽，将于 2026-10-24 18:00 恢复', NOW)
    expect(r.kind).toBe('quota')
    expect(r.resetAt).toBe(new Date(2026, 9, 24, 18, 0, 0).getTime())
    expect(r.match).toContain('额度')
  })

  it('额度不足（英文 quota exceeded / OpenAI 文案）', () => {
    expect(classifyError('You exceeded your current quota, please check your plan and billing', NOW).kind).toBe('quota')
    expect(classifyError('429 usage allocated quota exceeded', NOW).kind).toBe('quota')
  })

  it('GLM 业务码：1308/1310 额度、1113 欠费、1309 套餐过期、1302 限流、1305 过载', () => {
    expect(classifyError('Usage limit reached (1308). Your plan will reset at 22:00', NOW).kind).toBe('quota')
    expect(classifyError('error code 1310: weekly quota exhausted', NOW).kind).toBe('quota')
    expect(classifyError('1113 欠费，请充值后重试', NOW).kind).toBe('quota')
    expect(classifyError('GLM Coding Plan expired (1309)', NOW).kind).toBe('auth')
    expect(classifyError('1302: request rate limit reached', NOW).kind).toBe('ratelimit')
    expect(classifyError('1305 service is overloaded', NOW).kind).toBe('server')
  })

  it('鉴权失败：401/密钥无效', () => {
    expect(classifyError('unexpected status 401 Unauthorized', NOW).kind).toBe('auth')
    expect(classifyError('Invalid API key provided', NOW).kind).toBe('auth')
    expect(classifyError('鉴权失败：密钥无效', NOW).kind).toBe('auth')
  })

  it('GLM 5 小时窗口额度：仅文案（无业务码）也能识别并解析恢复时间', () => {
    const r = classifyError(
      '已达到 5 小时的使用上限。您的限额将在 2026-10-25 18:48:03 重置。',
      NOW
    )
    expect(r.kind).toBe('quota')
    expect(r.resetAt).toBe(new Date(2026, 9, 25, 18, 48, 3).getTime())
  })

  it('供应商 rate-limit 原始事件（provider.rate-limit + 1308）→ quota 而非 unknown', () => {
    const message = '已达到 5 小时的使用上限。您的限额将在 2026-10-25 18:48:03 重置。'
    const raw = JSON.stringify({
      type: 'error',
      timestamp: 1792922353847,
      sessionID: 'ses_ea147f3edffdInxJ4GTwJkuNe7',
      error: {
        type: 'provider.rate-limit',
        message,
        status: 429,
        response: { body: JSON.stringify({ error: { code: '1308', message } }) }
      }
    })
    const r = classifyError(raw, NOW)
    expect(r.kind).toBe('quota')
    expect(r.resetAt).toBe(new Date(2026, 9, 25, 18, 48, 3).getTime())
    // 无额度语义的限流文案仍按 ratelimit 处理
    expect(classifyError('{"error":{"type":"provider.rate-limit","message":"too many requests"}}', NOW).kind).toBe(
      'ratelimit'
    )
  })

  it('429 限流无额度语义 → ratelimit，且解析重试等待时间', () => {
    const r = classifyError('HTTP 429 Too Many Requests, please try again in 30s', NOW)
    expect(r.kind).toBe('ratelimit')
    expect(r.resetAt).toBe(NOW + 30 * 1000)
  })

  it('服务端过载与网络错误', () => {
    expect(classifyError('HTTP 503 Service Unavailable', NOW).kind).toBe('server')
    expect(classifyError('model service overloaded_error', NOW).kind).toBe('server')
    expect(classifyError('fetch failed: ECONNRESET', NOW).kind).toBe('network')
    expect(classifyError('getaddrinfo ENOTFOUND api.example.com', NOW).kind).toBe('network')
  })

  it('opencode run error 事件的原始文本可分类', () => {
    const ev = {
      type: 'error',
      error: {
        name: 'APIError',
        data: { message: 'Rate limit exceeded. quota will reset at 2026-10-24 17:00', statusCode: 429 }
      }
    }
    const raw = JSON.stringify(ev)
    const msg = ev.error.data.message + ` statusCode=${ev.error.data.statusCode}`
    const r = classifyError(msg, NOW)
    expect(r.kind).toBe('quota')
    expect(raw).toContain('statusCode')
  })

  it('未知错误与空文本', () => {
    expect(classifyError('Segmentation fault', NOW).kind).toBe('unknown')
    expect(classifyError('', NOW).kind).toBe('unknown')
  })
})

describe('planRecovery（分级处理策略）', () => {
  const quota = (resetAt = null) => ({ kind: 'quota', resetAt, match: '额度' })

  it('额度不足 + 有恢复时间 + 无备选 → 等到恢复点（不超过探活间隔）', () => {
    const resetAt = NOW + 5 * 3600 * 1000
    // 探活间隔比恢复点更远：按恢复点等
    const p = planRecovery(quota(resetAt), { hasFallback: false, retryDelaySec: 120, now: NOW, probeMs: 24 * 3600 * 1000 })
    expect(p.action).toBe('wait')
    expect(p.until).toBe(resetAt)
    expect(p.reason).toContain('额度')
    // 恢复点很远时只等到下一次探活：充值/提前解封后能尽快恢复
    const capped = planRecovery(quota(resetAt), { hasFallback: false, retryDelaySec: 120, now: NOW, probeMs: 60 * 1000 })
    expect(capped.until).toBe(NOW + 60 * 1000)
    expect(capped.reason).toContain('探活')
    // 误解析的超远时间被封顶
    const p2 = planRecovery(quota(NOW + 100 * 24 * 3600 * 1000), {
      hasFallback: false,
      retryDelaySec: 120,
      now: NOW,
      probeMs: 24 * 3600 * 1000,
      maxWaitMs: 3600 * 1000
    })
    expect(p2.until).toBe(NOW + 3600 * 1000)
  })

  it('额度不足 + 有备选模型 → 立即切换，不等常规重启间隔', () => {
    const p = planRecovery(quota(NOW + 5 * 3600 * 1000), { hasFallback: true, retryDelaySec: 120, now: NOW })
    expect(p.action).toBe('retry')
    expect(p.switchModel).toBe(true)
    expect(p.delaySec).toBe(1)
    // 可显式指定切换等待
    expect(
      planRecovery(quota(NOW + 5 * 3600 * 1000), { hasFallback: true, retryDelaySec: 120, now: NOW, switchDelaySec: 5 })
        .delaySec
    ).toBe(5)
  })

  it('额度不足 + 无恢复时间：有备选立即切换；无备选按探活间隔等待（不消耗重启次数）', () => {
    const withFb = planRecovery(quota(), { hasFallback: true, retryDelaySec: 120, now: NOW })
    expect(withFb.switchModel).toBe(true)
    const noFb = planRecovery(quota(), { hasFallback: false, retryDelaySec: 120, now: NOW })
    expect(noFb.action).toBe('wait')
    expect(noFb.until).toBe(NOW + MODEL_PROBE_MS)
    expect(noFb.reason).toContain('探活')
  })

  it('鉴权失败：有备选切换；其他模型仅额度冷却时等待其解封；完全没有可恢复备选才停止', () => {
    expect(planRecovery({ kind: 'auth', resetAt: null }, { hasFallback: true, retryDelaySec: 120 }).action).toBe('retry')
    const wait = planRecovery(
      { kind: 'auth', resetAt: null },
      { hasFallback: false, retryDelaySec: 120, now: NOW, recoverableUntil: NOW + 30 * 1000 }
    )
    expect(wait.action).toBe('wait')
    expect(wait.until).toBe(NOW + 30 * 1000)
    expect(wait.reason).toContain('等待')
    const stop = planRecovery({ kind: 'auth', resetAt: null }, { hasFallback: false, retryDelaySec: 120 })
    expect(stop.action).toBe('stop')
    expect(stop.reason).toContain('鉴权')
  })

  it('限流：无时间窗退避 ≥60s；带时间窗且无备选 → wait（不超过探活间隔）', () => {
    const p = planRecovery({ kind: 'ratelimit', resetAt: null }, { hasFallback: false, retryDelaySec: 5 })
    expect(p.action).toBe('retry')
    expect(p.delaySec).toBeGreaterThanOrEqual(60)
    const w = planRecovery(
      { kind: 'ratelimit', resetAt: NOW + 90 * 1000 },
      { hasFallback: false, retryDelaySec: 5, now: NOW, probeMs: 10 * 60 * 1000 }
    )
    expect(w.action).toBe('wait')
    expect(w.until).toBe(NOW + 90 * 1000)
    // 限流窗口很长时按探活间隔提前试
    const capped = planRecovery(
      { kind: 'ratelimit', resetAt: NOW + 90 * 1000 },
      { hasFallback: false, retryDelaySec: 5, now: NOW, probeMs: 60 * 1000 }
    )
    expect(capped.until).toBe(NOW + 60 * 1000)
  })

  it('网络/服务端/未知 → 常规重启，不切换模型', () => {
    for (const kind of ['network', 'server', 'unknown']) {
      const p = planRecovery({ kind, resetAt: null }, { hasFallback: true, retryDelaySec: 120 })
      expect(p.action).toBe('retry')
      expect(p.switchModel).toBe(false)
      expect(p.delaySec).toBe(120)
    }
  })
})

describe('cooldownUntil（模型受限冷却 → 自动切回主力的时间点）', () => {
  it('额度/限流：恢复时间只作上界，冷却不超过探活间隔', () => {
    const resetAt = NOW + 2 * 3600 * 1000
    expect(cooldownUntil({ kind: 'quota', resetAt }, NOW)).toBe(NOW + MODEL_PROBE_MS)
    expect(cooldownUntil({ kind: 'ratelimit', resetAt }, NOW)).toBe(NOW + MODEL_PROBE_MS)
    // 恢复点更近时按恢复点
    expect(cooldownUntil({ kind: 'quota', resetAt: NOW + 30 * 1000 }, NOW)).toBe(NOW + 30 * 1000)
  })

  it('额度/限流无恢复时间 → 按探活间隔稍后重试', () => {
    expect(cooldownUntil({ kind: 'quota', resetAt: null }, NOW)).toBe(NOW + MODEL_PROBE_MS)
    expect(cooldownUntil({ kind: 'ratelimit', resetAt: null }, NOW, 5000)).toBe(NOW + 5000)
  })

  it('鉴权失败：探活间隔至少 30 分钟（避免频繁无效请求）', () => {
    expect(cooldownUntil({ kind: 'auth', resetAt: null }, NOW, 5000)).toBe(NOW + AUTH_PROBE_MS)
    expect(cooldownUntil({ kind: 'auth', resetAt: null }, NOW)).toBe(NOW + AUTH_PROBE_MS)
  })

  it('已过去的恢复时间视为无效 → 回落到探活间隔', () => {
    expect(cooldownUntil({ kind: 'quota', resetAt: NOW - 1000 }, NOW, 6000)).toBe(NOW + 6000)
  })

  it('网络/服务端/未知错误不冷却模型', () => {
    for (const kind of ['network', 'server', 'unknown']) {
      expect(cooldownUntil({ kind, resetAt: NOW + 1000 }, NOW)).toBeNull()
    }
    expect(cooldownUntil(null, NOW)).toBeNull()
  })
})

describe('展示辅助', () => {
  it('formatWait 人性化时长', () => {
    expect(formatWait(45 * 1000)).toBe('45 秒')
    expect(formatWait(260 * 1000)).toBe('4 分 20 秒')
    expect(formatWait((3 * 3600 + 12 * 60) * 1000)).toBe('3 小时 12 分')
  })

  it('formatClock 输出 MM-dd HH:mm:ss', () => {
    expect(formatClock(new Date(2026, 9, 24, 18, 5, 3).getTime())).toBe('10-24 18:05:03')
  })

  it('KIND_TEXT 覆盖全部分类', () => {
    for (const k of ['quota', 'auth', 'ratelimit', 'server', 'network', 'unknown']) {
      expect(KIND_TEXT[k]).toBeTruthy()
    }
  })

  it('LIMIT_TEXT 覆盖会产生冷却的三类限制', () => {
    for (const k of ['quota', 'ratelimit', 'auth']) {
      expect(LIMIT_TEXT[k]).toBeTruthy()
    }
  })
})
