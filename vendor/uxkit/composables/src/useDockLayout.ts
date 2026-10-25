import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue'

export type DockZone = 'left' | 'right' | 'bottom'
export type DockZoneSizes = Record<DockZone, number>

const ZONES: DockZone[] = ['left', 'right', 'bottom']

const DEFAULT_SIZES: DockZoneSizes = { left: 260, right: 220, bottom: 200 }
const DEFAULT_LIMITS: Record<DockZone, [number, number]> = {
  left: [200, 560],
  right: [140, 420],
  bottom: [120, 480],
}

const FLOAT_W = 480
const FLOAT_H = 360
const FLOAT_STEP = 28

export interface FloatGeom {
  x: number
  y: number
  w: number
  h: number
}

export interface DockPanelSeed {
  /** 初始停靠区（null = 初始隐藏） */
  zone?: DockZone | null
  /** 最近停靠区（隐藏/悬浮后「回收」目标），默认取 zone */
  lastZone?: DockZone
  /** 悬浮窗几何 */
  float?: FloatGeom
  /** 悬浮窗是否最小化（收进层叠条） */
  minimized?: boolean
}

export interface DockLayoutOptions {
  /** localStorage key（单一入口） */
  key: string
  /** 面板定义：id → 初始状态 */
  panels: Record<string, DockPanelSeed>
  /** 各区默认尺寸 */
  sizes?: Partial<DockZoneSizes>
  /** 各区尺寸限制 [min, max] */
  limits?: Partial<Record<DockZone, [number, number]>>
}

interface PanelState {
  zone: DockZone | null
  lastZone: DockZone
  float?: FloatGeom
  minimized: boolean
}

export interface DockLayout {
  /** 各区尺寸（响应式，直接用于 CSS 宽度/高度） */
  sizes: DockZoneSizes
  /** 各区尺寸限制 [min, max] */
  limits: Record<DockZone, [number, number]>
  /** 当前活动面板 id（活动栏高亮 / 状态栏显示） */
  active: Ref<string | null>
  /** 拖拽中的面板 id（非空时显示投放遮罩） */
  dragging: Ref<string | null>
  /** 悬浮中的面板 id 列表（含已最小化） */
  floating: ComputedRef<string[]>
  /** 某区当前承载的面板 id（无则 null） */
  panelInZone(zone: DockZone): string | null
  geomOf(id: string): FloatGeom | null
  zOf(id: string): number
  isVisible(id: string): boolean
  isActive(id: string): boolean
  isFloating(id: string): boolean
  isMinimized(id: string): boolean
  /** 激活面板：停靠到其目标区，同区占用者让位隐藏 */
  activate(id: string): void
  /** 已显示且活动 → 隐藏；否则激活 */
  toggle(id: string): void
  hide(id: string): void
  show(id: string): void
  /** 拖拽换区：目标区已有面板则交换（被换下面板回来源；来源为悬浮/隐藏则转悬浮） */
  dock(id: string, zone: DockZone): void
  /** 转悬浮（保留已有几何，否则级联生成并置焦） */
  float(id: string): void
  /** 悬浮回收停靠（回最近区） */
  dockBack(id: string): void
  minimize(id: string): void
  restore(id: string): void
  focusFloat(id: string): void
  setGeom(id: string, patch: Partial<FloatGeom>): void
  beginDrag(id: string): void
  endDrag(): void
  resizeZone(zone: DockZone, size: number): void
  reset(): void
}

function isGeom(value: unknown): value is FloatGeom {
  if (!value || typeof value !== 'object') return false
  const g = value as Partial<FloatGeom>
  return typeof g.x === 'number' && typeof g.y === 'number' && typeof g.w === 'number' && typeof g.h === 'number'
}

function isZone(value: unknown): value is DockZone {
  return value === 'left' || value === 'right' || value === 'bottom'
}

/**
 * 工作台停靠布局状态机（提炼自 PersonalDb layout 状态机）。
 * 一区一面板；支持停靠/交换/悬浮/最小化层叠；尺寸分区独立记忆；变更防抖持久化。
 */
export function useDockLayout(options: DockLayoutOptions): DockLayout {
  const sizes = reactive<DockZoneSizes>({ ...DEFAULT_SIZES, ...options.sizes })
  const limits: Record<DockZone, [number, number]> = { ...DEFAULT_LIMITS, ...options.limits }
  const seeds = { ...options.panels }
  const ids = Object.keys(seeds)

  const panels = reactive<Record<string, PanelState>>({})
  for (const [id, seed] of Object.entries(seeds)) {
    const zone = seed.zone === undefined ? 'left' : seed.zone
    panels[id] = {
      zone,
      lastZone: seed.lastZone ?? zone ?? 'left',
      float: seed.float,
      minimized: Boolean(seed.minimized),
    }
  }

  const focusZ = reactive(new Map<string, number>())
  const zTop = ref(100)

  try {
    const raw = localStorage.getItem(options.key)
    if (raw) {
      const parsed = JSON.parse(raw) as {
        panels?: Record<string, Partial<PanelState>>
        sizes?: Partial<DockZoneSizes>
        zones?: Record<string, DockZone | null>
        lastZones?: Record<string, DockZone>
      }
      if (parsed.panels) {
        for (const id of ids) {
          const p = parsed.panels[id]
          if (!p || typeof p !== 'object') continue
          const state = panels[id]
          state.zone = isZone(p.zone) ? p.zone : null
          if (isZone(p.lastZone)) state.lastZone = p.lastZone
          state.float = isGeom(p.float) ? p.float : undefined
          state.minimized = Boolean(p.minimized)
        }
      } else if (parsed.zones) {
        for (const id of ids) {
          if (!(id in parsed.zones)) continue
          const value = parsed.zones[id]
          panels[id].zone = isZone(value) ? value : null
          const last = parsed.lastZones?.[id]
          if (isZone(last)) panels[id].lastZone = last
        }
      }
      if (parsed.sizes) {
        for (const zone of ZONES) {
          const size = parsed.sizes[zone]
          if (typeof size === 'number') sizes[zone] = size
        }
      }
    }
  } catch {
    /* 损坏数据回退默认 */
  }

  const active = ref<string | null>(ids.find((id) => panels[id].zone !== null) ?? null)
  const dragging = ref<string | null>(null)

  const floating = computed(() => ids.filter((id) => panels[id].zone === null && panels[id].float))

  let timer: number | undefined
  function persist(): void {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      try {
        localStorage.setItem(options.key, JSON.stringify({ panels: { ...panels }, sizes: { ...sizes } }))
      } catch {
        /* 配额/隐私模式失败可忽略 */
      }
    }, 150)
  }

  watch(() => [panels, sizes], persist, { deep: true })

  function panelInZone(zone: DockZone): string | null {
    return ids.find((id) => panels[id].zone === zone) ?? null
  }

  function clampGeom(g: FloatGeom): FloatGeom {
    const vw = window.innerWidth
    const vh = window.innerHeight
    return {
      w: Math.min(1200, Math.max(280, g.w)),
      h: Math.min(1400, Math.max(180, g.h)),
      x: Math.min(vw - 120, Math.max(-40, g.x)),
      y: Math.min(vh - 60, Math.max(0, g.y)),
    }
  }

  function nextFloatGeom(): FloatGeom {
    const open = floating.value.filter((id) => !panels[id].minimized).length
    const offset = Math.min(open, 6) * FLOAT_STEP
    return clampGeom({ x: 120 + offset, y: 90 + offset, w: FLOAT_W, h: FLOAT_H })
  }

  function focusFloat(id: string): void {
    const p = panels[id]
    if (!(id in seeds) || p.zone !== null || !p.float) return
    zTop.value += 1
    focusZ.set(id, zTop.value)
  }

  function zOf(id: string): number {
    return focusZ.get(id) ?? 100
  }

  /** 显示到目标区：同区占用者让位隐藏（活动栏语义） */
  function activate(id: string): void {
    if (!(id in seeds)) return
    const target = panels[id].zone ?? panels[id].lastZone
    const occupant = panelInZone(target)
    if (occupant && occupant !== id) panels[occupant].zone = null
    panels[id].zone = target
    panels[id].lastZone = target
    panels[id].float = undefined
    panels[id].minimized = false
    active.value = id
  }

  function hide(id: string): void {
    if (!(id in seeds)) return
    const zone = panels[id].zone ?? panels[id].lastZone
    panels[id].zone = null
    if (active.value === id) active.value = panelInZone(zone)
  }

  function toggle(id: string): void {
    const p = panels[id]
    if (!(id in seeds)) return
    if (p.zone === null) {
      if (p.float && !p.minimized) {
        focusFloat(id)
        return
      }
      activate(id)
      return
    }
    if (active.value === id) hide(id)
    else activate(id)
  }

  /** 拖拽换区：交换语义（占用者回来源；来源为悬浮/隐藏则占用者转悬浮） */
  function dock(id: string, zone: DockZone): void {
    if (!(id in seeds)) return
    const from = panels[id]
    if (from.zone === zone) return
    const occupant = panelInZone(zone)
    const fromZone = from.zone
    from.zone = zone
    from.lastZone = zone
    from.float = undefined
    from.minimized = false
    if (occupant && occupant !== id) {
      const occ = panels[occupant]
      if (fromZone !== null) {
        occ.zone = fromZone
        occ.lastZone = fromZone
        occ.float = undefined
      } else {
        occ.zone = null
        occ.float = nextFloatGeom()
      }
    }
    active.value = id
  }

  function float(id: string): void {
    if (!(id in seeds)) return
    const p = panels[id]
    if (p.zone) p.lastZone = p.zone
    else if (p.float) {
      // 已是悬浮：仅置焦
      focusFloat(id)
      p.minimized = false
      return
    }
    p.zone = null
    p.float = p.float ? clampGeom(p.float) : nextFloatGeom()
    p.minimized = false
    active.value = id
    focusFloat(id)
  }

  function dockBack(id: string): void {
    if (!(id in seeds) || panels[id].zone !== null) return
    activate(id)
  }

  function minimize(id: string): void {
    const p = panels[id]
    if (!(id in seeds) || p.zone !== null || !p.float) return
    p.minimized = true
    if (active.value === id) active.value = null
  }

  function restore(id: string): void {
    const p = panels[id]
    if (!(id in seeds) || p.zone !== null || !p.float) return
    p.minimized = false
    active.value = id
    focusFloat(id)
  }

  function setGeom(id: string, patch: Partial<FloatGeom>): void {
    const p = panels[id]
    if (!(id in seeds) || !p.float) return
    p.float = clampGeom({ ...p.float, ...patch })
  }

  function resizeZone(zone: DockZone, size: number): void {
    const [min, max] = limits[zone]
    sizes[zone] = Math.min(max, Math.max(min, Math.round(size)))
  }

  function reset(): void {
    for (const [id, seed] of Object.entries(seeds)) {
      const zone = seed.zone === undefined ? 'left' : seed.zone
      panels[id] = {
        zone,
        lastZone: seed.lastZone ?? zone ?? 'left',
        float: seed.float,
        minimized: Boolean(seed.minimized),
      }
    }
    Object.assign(sizes, DEFAULT_SIZES, options.sizes ?? {})
    focusZ.clear()
    zTop.value = 100
    dragging.value = null
    active.value = ids.find((id) => panels[id].zone !== null) ?? null
    try {
      localStorage.removeItem(options.key)
    } catch {
      /* 忽略 */
    }
  }

  return {
    sizes,
    limits,
    active,
    dragging,
    floating,
    panelInZone,
    geomOf: (id: string) => panels[id]?.float ?? null,
    zOf,
    isVisible: (id: string) => panels[id]?.zone !== null && panels[id]?.zone !== undefined,
    isActive: (id: string) => active.value === id,
    isFloating: (id: string) => panels[id]?.zone === null && Boolean(panels[id]?.float),
    isMinimized: (id: string) => Boolean(panels[id]?.minimized),
    activate,
    toggle,
    hide,
    show: activate,
    dock,
    float,
    dockBack,
    minimize,
    restore,
    focusFloat,
    setGeom,
    beginDrag: (id: string) => {
      if (id in seeds) dragging.value = id
    },
    endDrag: () => {
      dragging.value = null
    },
    resizeZone,
    reset,
  }
}
