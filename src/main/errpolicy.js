/**
 * errpolicy.js — opencode 运行错误分类与分级处理策略（纯函数，可单测）
 *
 * 数据来源：
 * - `opencode run --format json` 的 error 事件：
 *   { type:'error', error:{ name, data:{ message, statusCode, isRetryable } } }
 * - stderr / 非结构化输出中的原始错误文案
 *
 * 分类（kind）→ 策略（planRecovery）：
 * - quota     额度/套餐用尽（429+1308/1310、quota exceeded、额度不足、欠费…）
 *             → 尽力从消息解析恢复时间：无备选模型时等到恢复点自动继续；
 *               有备选模型则立即切换（不同模型/供应商通常独立计额）
 * - auth      401/403、密钥无效、套餐过期（1309）
 *             → 有备选模型切换重试；否则停止守护（同配置重试无意义）
 * - ratelimit 429 限流/并发（1302、too many requests）
 *             → 至少退避 60s 再重试
 * - server    5xx/过载（1305、overloaded）→ 常规重启
 * - network   连接类错误（ECONNRESET/超时/DNS…）→ 常规重启
 * - unknown   → 常规重启（与旧行为一致）
 */

/** 错误分类的中文标签（日志与 UI 展示用） */
export const KIND_TEXT = {
  quota: '额度不足',
  auth: '鉴权失败',
  ratelimit: '触发限流',
  server: '服务端过载',
  network: '网络异常',
  unknown: '未知错误'
}

/** 模型受限原因（贴合「限制已解除 / 已切换备选」句式，仅额度/限流/鉴权会产生冷却） */
export const LIMIT_TEXT = {
  quota: '额度限制',
  ratelimit: '限流限制',
  auth: '鉴权问题'
}

// ---------- 恢复时间解析 ----------

const UNIT_MS = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 3600 * 1000,
  hr: 3600 * 1000,
  hrs: 3600 * 1000,
  hour: 3600 * 1000,
  hours: 3600 * 1000,
  d: 24 * 3600 * 1000,
  day: 24 * 3600 * 1000,
  days: 24 * 3600 * 1000,
  秒: 1000,
  秒钟: 1000,
  分: 60 * 1000,
  分钟: 60 * 1000,
  时: 3600 * 1000,
  小时: 3600 * 1000,
  个小时: 3600 * 1000,
  天: 24 * 3600 * 1000
}

/** 今天/明天某一时刻（本地或 UTC）的 epoch ms；已过去则顺延一天 */
function timeToday(h, mi, se, utc, now) {
  const d = new Date(now)
  let t
  if (utc) {
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi, se)
  } else {
    t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi, se).getTime()
  }
  if (t <= now) t += 24 * 3600 * 1000
  return t
}

/**
 * 从错误文案中解析额度恢复时间，返回 epoch ms（解析失败返回 null）。
 * 依次尝试：完整日期时间 → am/pm 时刻 → 带上下文关键词的 HH:MM → 相对时长。
 */
export function parseResetTime(text, now = Date.now()) {
  const s = String(text || '')
  if (!s) return null

  // 1) 完整日期时间：2026-10-24 20:00[:00]，可带 UTC/GMT 标记（按 UTC 换算）
  let m = s.match(
    /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|\+00:?00)?/i
  )
  if (m) {
    const t = m[7]
      ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime()
    if (Number.isFinite(t)) return t
  }

  // 2) 12 小时制："resets 5pm" / "5:30 PM"（须先于无标记的 HH:MM 判断，避免 5:30 PM 被当作凌晨）
  m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (m) {
    let h = +m[1] % 12
    if (/pm/i.test(m[3])) h += 12
    return timeToday(h, +(m[2] || 0), 0, false, now)
  }

  // 3) 带上下文的时刻："reset at 22:00" / "恢复时间：20:30" / "将于 0:00 重置" / "22:00 UTC 恢复"
  const ctx =
    s.match(
      /(?:resets?|恢复时间|重置时间|恢复于|重置于|恢复|重置|将于|until)\s*[^0-9\n]{0,10}(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT)?/i
    ) ||
    s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|GMT)?\s*(?:后|之后)?\s*(?:恢复|重置|resets?)/i)
  if (ctx) {
    const h = +ctx[1]
    const mi = +ctx[2]
    if (h >= 0 && h < 24 && mi >= 0 && mi < 60) {
      return timeToday(h, mi, +(ctx[3] || 0), !!ctx[4], now)
    }
  }

  // 4) 相对时长："please try again in 20s" / "等待 5 分钟后重试" / "retry after 2 minutes"
  m =
    s.match(/\b(?:in|after)\s+(\d{1,4})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i) ||
    s.match(/(\d{1,4})\s*(秒钟|秒|分钟|分|个小时|小时|时|天)\s*(?:后|之后)/) ||
    s.match(/(?:等待|等|延时|延迟|重试)\s*(\d{1,4})\s*(秒钟|秒|分钟|分|个小时|小时|时|天)/)
  if (m) {
    const unit = String(m[2] || '').toLowerCase()
    const ms = UNIT_MS[unit]
    if (ms) return now + Number(m[1]) * ms
  }
  return null
}

// ---------- 错误分类 ----------

/** 额度/套餐用尽（各家中英文文案 + GLM 业务码 1308/1310/1113） */
const QUOTA_RE = new RegExp(
  [
    'quota[\\s\\S]{0,60}?(?:exceeded|exhausted|used\\s?up|reached|has\\s+run\\s+out)',
    '(?:exceeded|exhausted|used\\s+up)[\\s\\S]{0,20}?quota',
    '(?:hour|week|month|usage)\\s+allocated\\s+quota',
    'token[- ]?plan\\s+quota[\\s\\S]{0,20}?(?:exhausted|exceeded)',
    'usage\\s+limit\\s+(?:reached|exceeded)',
    'remaining\\s+(?:quota|limit)\\s+(?:is\\s+)?(?:exhausted|zero)',
    '额度[^。\\n]{0,10}(?:用尽|用完|耗尽|不足|超限|已达上限)',
    '配额[^。\\n]{0,10}(?:用尽|用完|耗尽|不足|超限|已达上限)',
    '用量[^。\\n]{0,10}(?:已达上限|超限|用完|用尽)',
    // 5 小时/周窗口型额度（GLM Coding Plan 等）："已达到 5 小时的使用上限，限额将在 … 重置"
    '(?:已达到|已达|超出|超过)[^。\\n]{0,12}(?:使用|用量|调用|请求)(?:量|次数)?(?:上限|限额)',
    '(?:使用|用量|调用|请求)(?:额度|上限|限额)[^。\\n]{0,10}(?:用尽|用完|耗尽|不足|超限|已达)',
    '限额[^。\\n]{0,10}(?:用尽|用完|耗尽|已满|达到上限)',
    '套餐(?:额度)?[^。\\n]{0,10}(?:用完|用尽|耗尽|已到期|过期)',
    'arrears|欠费|余额不足|账户余额[^。\\n]{0,6}(?:不足|为零)',
    '\\b1308\\b|\\b1310\\b|\\b1113\\b'
  ].join('|'),
  'i'
)

/** 鉴权失败：密钥无效/未授权/套餐过期（1309）——同配置重试通常无意义 */
const AUTH_RE = new RegExp(
  [
    '\\b(?:status(?:code)?|http)\\s*[=: ]?\\s*40[13]\\b',
    'unexpected\\s+status\\s+40[13]',
    'unauthorized|invalid[ _-]?(?:api[ _-]?)?key|invalid[ _-]?token|invalid\\s+credentials?',
    'authentication(?:\\s+failed)?|api\\s+key\\s+not\\s+valid|check\\s+your\\s+(?:api\\s+)?key',
    '鉴权失败|密钥无效|无效的密钥|密钥不正确|认证失败',
    'plan\\s+has\\s+expired|套餐已过期|\\b1309\\b|\\b1311\\b'
  ].join('|'),
  'i'
)

/** 临时限流/并发（1302 等）：退避后可恢复 */
const RATE_RE = new RegExp(
  [
    '\\b429\\b',
    'rate[ _-]?limit(?:ed)?(?:[ _-]?error)?',
    'provider\\.rate[ _-]?limit',
    'too\\s+many\\s+requests',
    '请求过于频繁|请求超频|触发限流|限流|并发(?:数)?(?:超限|已达上限|限制|不足)',
    '\\b1302\\b|\\b700020\\b|\\b700021\\b|\\b700022\\b'
  ].join('|'),
  'i'
)

/** 服务端过载/故障（1305、5xx、overloaded） */
const SERVER_RE = new RegExp(
  [
    '(?:status(?:code)?|http)\\s*[=: ]?\\s*5(?:00|02|03|04|29)\\b',
    'internal\\s+server\\s+error|bad\\s+gateway|service\\s+unavailable',
    'server\\s+overloaded|overloaded[ _-]?error|temporarily\\s+overloaded',
    '模型(?:服务)?(?:繁忙|过载)|服务(?:器)?(?:繁忙|过载|错误)|上游(?:服务)?错误',
    '\\b1305\\b'
  ].join('|'),
  'i'
)

/** 网络连接类错误：进程本地或链路问题 */
const NET_RE = new RegExp(
  [
    'ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH',
    'socket\\s+hang\\s+up|fetch\\s+failed|getaddrinfo',
    'network\\s+(?:error|timeout|unreachable)|connection\\s+(?:reset|refused|closed|timed?\\s?out)',
    '\\btimed?[\\s-]?out\\b|timeout\\s+(?:of\\s+\\d+|error)',
    '连接被重置|连接失败|网络(?:错误|异常|超时|连接失败)|请求超时'
  ].join('|'),
  'i'
)

function firstMatch(re, text) {
  const m = re.exec(text)
  if (!m) return ''
  return String(m[0]).replace(/\s+/g, ' ').trim().slice(0, 100)
}

/**
 * 错误文本 → 分类结果。
 * 优先级：quota → auth → ratelimit → server → network → unknown
 * （quota 先判：429 携带额度语义时按额度处理，等待恢复而非盲目退避）
 */
export function classifyError(text, now = Date.now()) {
  const s = String(text || '').slice(0, 20000)
  if (!s.trim()) return { kind: 'unknown', resetAt: null, match: '' }
  if (QUOTA_RE.test(s)) {
    return { kind: 'quota', resetAt: parseResetTime(s, now), match: firstMatch(QUOTA_RE, s) }
  }
  if (AUTH_RE.test(s)) return { kind: 'auth', resetAt: null, match: firstMatch(AUTH_RE, s) }
  if (RATE_RE.test(s)) {
    return { kind: 'ratelimit', resetAt: parseResetTime(s, now), match: firstMatch(RATE_RE, s) }
  }
  if (SERVER_RE.test(s)) return { kind: 'server', resetAt: null, match: firstMatch(SERVER_RE, s) }
  if (NET_RE.test(s)) return { kind: 'network', resetAt: null, match: firstMatch(NET_RE, s) }
  return { kind: 'unknown', resetAt: null, match: '' }
}

// ---------- 恢复计划 ----------

/**
 * 分类结果 → 守护恢复计划。
 * 返回 { action, until, switchModel, delaySec, reason }：
 * - action 'wait'  ：等到 until（epoch ms）再拉起（额度恢复场景）
 * - action 'retry' ：按 delaySec 退避后重试；switchModel=true 时顺延备选模型
 * - action 'stop'  ：停止守护（鉴权失败且无备选）
 *
 * opts.probeMs：受限模型的探活间隔（等待点不会超过该间隔，便于充值后尽快恢复）
 * opts.switchDelaySec：切换模型前的等待秒数（默认 1s，不等常规重启间隔）
 * opts.recoverableUntil：其他「非鉴权」受限模型的最早解封时刻（epoch ms）。
 *   鉴权失败且当前无可用备选时，若还有只是额度/限流冷却的模型，先等它解封；
 *   只有所有模型都是鉴权问题（或根本没有其他模型）才停止守护。
 */
export function planRecovery(cls, opts = {}) {
  const retryDelaySec = Math.max(1, Number(opts.retryDelaySec) || 1)
  const hasFallback = !!opts.hasFallback
  const recoverableUntil = Number(opts.recoverableUntil) || 0
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : 24 * 3600 * 1000
  const probeMs = Number.isFinite(opts.probeMs) ? Math.max(1000, opts.probeMs) : MODEL_PROBE_MS
  /** 切换模型本身没有退避意义：不等常规重启间隔，立即用备选继续 */
  const switchDelaySec = Number.isFinite(opts.switchDelaySec)
    ? Math.max(1, Number(opts.switchDelaySec))
    : 1
  const base = { action: 'retry', until: null, switchModel: false, delaySec: retryDelaySec, reason: '' }
  const probeReason = `每 ${formatWait(probeMs)}探活一次，充值/解封后立即继续`
  /** 等待点：不超过探活间隔，充值或提前解封后才能尽快发现 */
  const probeUntil = (resetAt, floorMs) =>
    Math.min(Math.max(resetAt, now + floorMs), now + maxWaitMs, now + probeMs)

  switch (cls?.kind) {
    case 'quota': {
      // 无可用备选（没配置备选，或备选都在冷却）：不停止、不消耗重启次数，
      // 按恢复时间/探活间隔继续尝试；充值或提前解封后下一轮就能恢复。
      if (!hasFallback) {
        const target = cls.resetAt || now + probeMs
        const until = probeUntil(target, retryDelaySec * 1000)
        return {
          ...base,
          action: 'wait',
          until,
          delaySec: Math.max(1, Math.ceil((until - now) / 1000)),
          reason: `额度不足且暂无可用备选，${probeReason}`
        }
      }
      // 有备选模型：立即切换（不同模型通常独立计额）
      return {
        ...base,
        switchModel: true,
        delaySec: switchDelaySec,
        reason: '额度不足，立即切换备选模型重试'
      }
    }
    case 'auth':
      if (hasFallback) {
        return {
          ...base,
          switchModel: true,
          delaySec: switchDelaySec,
          reason: '鉴权失败，立即切换备选模型重试'
        }
      }
      // 其他模型只是额度/限流冷却：等它解封，不要因为当前模型鉴权失败就停掉整条链
      if (recoverableUntil > now) {
        const until = Math.min(Math.max(recoverableUntil, now + switchDelaySec * 1000), now + maxWaitMs)
        return {
          ...base,
          action: 'wait',
          until,
          delaySec: Math.max(1, Math.ceil((until - now) / 1000)),
          reason: `鉴权失败，其他模型仍在额度/限流冷却，等待其解封后重试`
        }
      }
      return { ...base, action: 'stop', reason: '鉴权失败（密钥无效或套餐过期），且无其他可恢复的备选模型' }
    case 'ratelimit': {
      const resetAt = cls.resetAt && cls.resetAt > now ? cls.resetAt : null
      if (resetAt && !hasFallback) {
        const until = probeUntil(resetAt, 0)
        return {
          ...base,
          action: 'wait',
          until,
          delaySec: Math.max(1, Math.ceil((until - now) / 1000)),
          reason: `触发限流，${probeReason}`
        }
      }
      return {
        ...base,
        delaySec: hasFallback ? switchDelaySec : Math.max(retryDelaySec, 60),
        switchModel: hasFallback,
        reason: hasFallback ? '触发限流，立即切换备选模型重试' : '触发限流，退避后重试'
      }
    }
    default:
      return base
  }
}

// ---------- 模型受限冷却 ----------

/**
 * 受限模型的探活间隔：到点自动重试，探到恢复即切回主力。
 * 默认 60 秒——额度耗光后立即降级、充值/解封后一分钟内就能切回，
 * 不再像旧版那样固定等 10 分钟（可在「设置 → 通用」调整）。
 */
export const MODEL_PROBE_MS = 60 * 1000
/** 鉴权类问题通常需人工处理：探活间隔更长，避免频繁无效请求 */
export const AUTH_PROBE_MS = 30 * 60 * 1000

/**
 * 失败分类 → 该模型的不可用截止时间（epoch ms）；null = 无需冷却。
 * 仅额度/限流/鉴权类错误会让模型进入冷却：错误文案里的恢复时间只作为上界，
 * 实际冷却不超过探活间隔——这样充值或提前解封后不必等满整个额度窗口。
 */
export function cooldownUntil(cls, now = Date.now(), probeMs = MODEL_PROBE_MS) {
  const kind = cls?.kind
  if (kind !== 'quota' && kind !== 'ratelimit' && kind !== 'auth') return null
  const probe = Number.isFinite(probeMs) ? Math.max(1000, probeMs) : MODEL_PROBE_MS
  const waitMs = kind === 'auth' ? Math.max(probe, AUTH_PROBE_MS) : probe
  const resetAt = Number(cls?.resetAt)
  if (Number.isFinite(resetAt) && resetAt > now) return Math.min(resetAt, now + waitMs)
  return now + waitMs
}

// ---------- 展示辅助 ----------

/** 时长人性化：1 小时 3 分 / 4 分 20 秒 / 45 秒 */
export function formatWait(ms) {
  const s = Math.max(0, Math.ceil(Number(ms) / 1000) || 0)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  const d = Math.floor(h / 24)
  return `${d} 天 ${h % 24} 小时`
}

/** 时刻格式化：MM-dd HH:mm:ss */
export function formatClock(t = Date.now()) {
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
