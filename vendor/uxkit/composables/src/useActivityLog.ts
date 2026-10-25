import { ref, shallowRef, type Ref } from 'vue'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  /** 时间戳（ms） */
  time: number
  level: LogLevel
  /** 一行摘要 */
  title: string
  /** 完整详情（可折叠展开） */
  detail?: string
}

export interface ActivityLogOptions {
  /** 环形缓冲上限，默认 1000（超出丢弃最旧） */
  limit?: number
  /** 可注入时间源（测试用） */
  now?: () => number
}

export interface ActivityLog {
  entries: Ref<LogEntry[]>
  /** 面板关闭期间累计的未读错误数，open 时清零 */
  unreadErrors: Ref<number>
  push(level: LogLevel, title: string, detail?: string): LogEntry
  /** 面板打开时调用：清零未读错误徽标 */
  markOpened(): void
  clear(): void
}

/**
 * 活动日志环形缓冲（会话内存，不落盘）：SQL 执行成败 / 连接事件等运行事件。
 * 提炼自 PersonalDb `stores/logs.ts`（SPEC-UI-23 日志面板）。
 */
export function useActivityLog(options: ActivityLogOptions = {}): ActivityLog {
  const limit = options.limit ?? 1000
  const now = options.now ?? (() => Date.now())
  const entries = shallowRef<LogEntry[]>([])
  const unreadErrors = ref(0)
  let seq = 0

  function push(level: LogLevel, title: string, detail?: string): LogEntry {
    const entry: LogEntry = { id: ++seq, time: now(), level, title, detail }
    const next = entries.value.concat(entry)
    entries.value = next.length > limit ? next.slice(next.length - limit) : next
    if (level === 'error') unreadErrors.value++
    return entry
  }

  function markOpened(): void {
    unreadErrors.value = 0
  }

  function clear(): void {
    entries.value = []
    unreadErrors.value = 0
  }

  return { entries, unreadErrors, push, markOpened, clear }
}
