import { onBeforeUnmount, watch, nextTick, type Ref } from 'vue'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

export interface FocusTrapOptions {
  active: Ref<boolean> | (() => boolean)
  /** Esc 键回调（可选：不传则 Esc 不处理） */
  onEscape?: () => void
  /** 关闭后是否归还焦点到打开前的元素，默认 true */
  returnFocus?: boolean
}

function isActive(o: FocusTrapOptions): boolean {
  return typeof o.active === 'function' ? o.active() : o.active.value
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

/**
 * 焦点陷阱：Tab 循环约束在容器内、进入时聚焦首个可聚焦元素、
 * 关闭后焦点归还到打开前的元素。对话框/命令面板的 a11y 基线。
 */
export function useFocusTrap(container: Ref<HTMLElement | null>, options: FocusTrapOptions): void {
  let prevFocus: HTMLElement | null = null

  function onKeydown(e: KeyboardEvent): void {
    const el = container.value
    if (!el || !isActive(options)) return
    if (e.key === 'Escape') {
      if (options.onEscape) {
        e.stopPropagation()
        options.onEscape()
      }
      return
    }
    if (e.key !== 'Tab') return
    const focusable = getFocusable(el)
    if (focusable.length === 0) {
      e.preventDefault()
      el.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const current = document.activeElement
    if (e.shiftKey && (current === first || !el.contains(current))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (current === last || !el.contains(current))) {
      e.preventDefault()
      first.focus()
    }
  }

  watch(
    () => isActive(options),
    (active) => {
      if (active) {
        prevFocus = document.activeElement as HTMLElement | null
        document.addEventListener('keydown', onKeydown, true)
        void nextTick(() => {
          const el = container.value
          if (!el) return
          const target = getFocusable(el)[0] ?? el
          target.focus()
        })
      } else {
        document.removeEventListener('keydown', onKeydown, true)
        if (options.returnFocus !== false && prevFocus) {
          prevFocus.focus()
          prevFocus = null
        }
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
  })
}
