import { computed, ref, type ComputedRef, type Ref } from 'vue'

/** 页签最小状态（组件层可扩展 icon 等展示字段） */
export interface TabItemState {
  id: string
  title: string
  /** 副标题（双行页签展示） */
  subtitle?: string
  /** 状态标记：on 正常 / lost 丢失（红）/ off 停用（灰化） */
  status?: 'on' | 'lost' | 'off'
  /** 标识色点（CSS 颜色，建议走语义令牌如 var(--ux-accent)） */
  accent?: string
  /** 未保存标记（圆点指示） */
  dirty?: boolean
  /** false 时隐藏关闭按钮且中键不可关 */
  closable?: boolean
}

export interface TabsOptions<T extends TabItemState> {
  /** 最大页签数（超出 open 返回 null；0/undefined = 不限） */
  max?: number
  /** 达到上限时回调（业务提示用） */
  onLimit?: (limit: number) => void
  /** 关闭守卫：返回 false 阻止关闭（仅作用于单个 close；批量关闭不经过守卫） */
  guardClose?: (tab: T) => boolean
}

export interface UxTabsApi<T extends TabItemState> {
  tabs: Ref<T[]>
  activeId: Ref<string>
  activeTab: ComputedRef<T | null>
  /** 新开页签（默认激活）；`dedupe` 命中时激活已有页签并返回它 */
  open(
    tab: Omit<T, 'id'> & { id?: string },
    opts?: { activate?: boolean; dedupe?: (t: T) => boolean },
  ): T | null
  activate(id: string): void
  /** 循环切换（Ctrl+Tab / Ctrl+Shift+Tab 风格），dir=-1 为反向 */
  cycle(dir?: 1 | -1): void
  close(id: string): void
  closeOthers(id: string): void
  closeRight(id: string): void
  closeLeft(id: string): void
  closeAll(): void
  /** 拖拽排序：将 fromId 移动到 toIndex（目标下标按移除后位置修正） */
  move(fromId: string, toIndex: number): void
  /** 快照导出/恢复（持久化介质由业务决定：localStorage / IndexedDB） */
  exportSnapshot(): T[]
  importSnapshot(list: T[], opts?: { activate?: string | 'first' }): void
}

/**
 * 页签数组状态机（提炼自 PersonalDb tabs store + MdReader TabBar）。
 * 关闭后激活邻位（右侧优先，末位回退左侧）；移动下标按移除后位置修正。
 */
export function useTabs<T extends TabItemState>(options: TabsOptions<T> = {}): UxTabsApi<T> {
  const tabs = ref<T[]>([]) as Ref<T[]>
  const activeId = ref('')

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null)

  function open(
    tab: Omit<T, 'id'> & { id?: string },
    opts: { activate?: boolean; dedupe?: (t: T) => boolean } = {},
  ): T | null {
    if (opts.dedupe) {
      const existing = tabs.value.find(opts.dedupe)
      if (existing) {
        activeId.value = existing.id
        return existing
      }
    }
    if (options.max && options.max > 0 && tabs.value.length >= options.max) {
      options.onLimit?.(options.max)
      return null
    }
    const id = tab.id ?? `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const next = { ...tab, id } as T
    if (opts.activate === false) {
      if (!tabs.value.length) activeId.value = id
      tabs.value.push(next)
    } else {
      tabs.value.push(next)
      activeId.value = id
    }
    return next
  }

  function activate(id: string): void {
    if (tabs.value.some((t) => t.id === id)) activeId.value = id
  }

  function cycle(dir: 1 | -1 = 1): void {
    const n = tabs.value.length
    if (!n) return
    const idx = tabs.value.findIndex((t) => t.id === activeId.value)
    const next = idx < 0 ? 0 : (idx + dir + n) % n
    activeId.value = tabs.value[next].id
  }

  function close(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    const tab = tabs.value[idx]
    if (tab.closable === false) return
    if (options.guardClose && !options.guardClose(tab)) return
    tabs.value.splice(idx, 1)
    if (activeId.value === id) {
      activeId.value = tabs.value[Math.min(idx, tabs.value.length - 1)]?.id ?? ''
    }
  }

  function closeOthers(id: string): void {
    const keep = tabs.value.find((t) => t.id === id)
    if (!keep) return
    tabs.value = tabs.value.filter((t) => t.id === id || t.closable === false)
    activeId.value = id
  }

  function closeRight(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    tabs.value = tabs.value.filter((t, i) => i <= idx || t.closable === false)
    if (!tabs.value.some((t) => t.id === activeId.value)) activeId.value = id
  }

  function closeLeft(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx <= 0) return
    tabs.value = tabs.value.filter((t, i) => i >= idx || t.closable === false)
    if (!tabs.value.some((t) => t.id === activeId.value)) activeId.value = id
  }

  function closeAll(): void {
    tabs.value = tabs.value.filter((t) => t.closable === false)
    activeId.value = tabs.value.find((t) => t.id === activeId.value)?.id ?? tabs.value[0]?.id ?? ''
  }

  function move(fromId: string, toIndex: number): void {
    const from = tabs.value.findIndex((t) => t.id === fromId)
    if (from < 0) return
    const [moved] = tabs.value.splice(from, 1)
    const idx = Math.max(0, Math.min(tabs.value.length, toIndex > from ? toIndex - 1 : toIndex))
    tabs.value.splice(idx, 0, moved)
  }

  function exportSnapshot(): T[] {
    return tabs.value.map((t) => ({ ...t }))
  }

  function importSnapshot(list: T[], opts: { activate?: string | 'first' } = {}): void {
    tabs.value = list.map((t) => ({ ...t }))
    if (opts.activate && opts.activate !== 'first') {
      activeId.value = tabs.value.some((t) => t.id === opts.activate) ? opts.activate : tabs.value[0]?.id ?? ''
    } else {
      activeId.value = tabs.value[0]?.id ?? ''
    }
  }

  return {
    tabs,
    activeId,
    activeTab,
    open,
    activate,
    cycle,
    close,
    closeOthers,
    closeRight,
    closeLeft,
    closeAll,
    move,
    exportSnapshot,
    importSnapshot,
  }
}
