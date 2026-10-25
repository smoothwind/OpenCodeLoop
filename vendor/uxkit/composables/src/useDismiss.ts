import { onBeforeUnmount, watch } from 'vue'

export type DismissReason = 'escape' | 'outside'

export interface DismissOptions {
  active: () => boolean
  onDismiss: (reason: DismissReason) => void
  /** 这些元素内部（含其后代）的指针事件不算"外部"，如触发按钮/浮层本身 */
  ignore?: () => (Element | null | undefined)[]
  /** 是否处理 Esc（默认 true）；菜单类需自行分层处理 Esc 时设为 false */
  escape?: boolean
}

/**
 * 浮层关闭：Esc 键 + 点击/触摸外部。菜单、下拉、气泡、对话框共用。
 * 使用 pointerdown 捕获，避免与 click 顺序竞争。
 */
export function useDismiss(options: DismissOptions): void {
  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !options.active()) return
    if (options.escape === false) return
    e.stopPropagation()
    options.onDismiss('escape')
  }

  function onPointerDown(e: PointerEvent): void {
    if (!options.active()) return
    const path = e.composedPath()
    const ignoreEls = options.ignore?.() ?? []
    for (const el of ignoreEls) {
      if (el && path.includes(el)) return
    }
    options.onDismiss('outside')
  }

  watch(options.active, (active) => {
    if (active) {
      document.addEventListener('keydown', onKeydown, true)
      document.addEventListener('pointerdown', onPointerDown, true)
    } else {
      document.removeEventListener('keydown', onKeydown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
  })
}
