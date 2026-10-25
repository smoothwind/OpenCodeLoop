import { onBeforeUnmount } from 'vue'

export interface HoverIntent {
  /** 重置计时并按 delay 后触发；重复调用会取消上一次（走廊语义） */
  schedule: (action: () => void) => void
  /** 取消尚未触发的意图 */
  cancel: () => void
}

/**
 * hover 意图延迟走廊：指针快速掠过不触发，停留 delay 毫秒后才执行；
 * 期间再次 schedule 会重置计时。用于菜单子项随 hover 展开 / 收起（APG）。
 */
export function useHoverIntent(delay = 120): HoverIntent {
  let timer = 0

  function cancel(): void {
    if (timer) {
      window.clearTimeout(timer)
      timer = 0
    }
  }

  function schedule(action: () => void): void {
    cancel()
    timer = window.setTimeout(() => {
      timer = 0
      action()
    }, delay)
  }

  onBeforeUnmount(cancel)

  return { schedule, cancel }
}
