/**
 * 连接类错误启发式识别（提炼自 PersonalDb tabs.ts）。
 * 命中则可提示"重连"；超时类不算连接错误（有独立的重试语义）。
 */
export function looksLikeConnError(msg: string): boolean {
  const m = msg.toLowerCase()
  if (m.includes('timeout') || m.includes('超时')) return false
  return (
    m.includes('session') ||
    m.includes('not connected') ||
    m.includes('connection') ||
    m.includes('连接') ||
    m.includes('closed') ||
    m.includes('broken') ||
    m.includes('pipe') ||
    m.includes('disconnect') ||
    m.includes('断开')
  )
}
