import { ref } from 'vue'

export type ToastType = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  type?: ToastType
  message: string
  /** 毫秒；<=0 表示不自动消失，默认 4000 */
  duration?: number
  action?: { label: string; run: () => void }
}

export interface ToastRecord extends ToastOptions {
  id: number
  type: ToastType
}

/**
 * 模块级单例通知状态。ToastHost 负责渲染，
 * 任意组件可直接调用 notify / notifyOnce，无需层级依赖。
 */
export const toastState = {
  toasts: ref<ToastRecord[]>([]),
}

const onceMap = new Map<string, number>()
let seq = 0

export function dismissToast(id: number): void {
  toastState.toasts.value = toastState.toasts.value.filter((t) => t.id !== id)
}

export function notify(options: ToastOptions | string): void {
  const opts = typeof options === 'string' ? { message: options } : options
  const id = ++seq
  toastState.toasts.value.push({
    id,
    type: opts.type ?? 'info',
    message: opts.message,
    action: opts.action,
  })
  const duration = opts.duration ?? 4000
  if (duration > 0) window.setTimeout(() => dismissToast(id), duration)
}

/** 同类通知 5 秒窗口内只出现一次（防多来源轰炸） */
export function notifyOnce(key: string, options: ToastOptions | string): void {
  const now = Date.now()
  if (now - (onceMap.get(key) ?? 0) < 5000) return
  onceMap.set(key, now)
  notify(options)
}
