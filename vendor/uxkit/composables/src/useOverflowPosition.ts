import { onBeforeUnmount, watch, type Ref } from 'vue'

export type Placement =
  | 'bottom-start'
  | 'bottom'
  | 'bottom-end'
  | 'top-start'
  | 'top'
  | 'top-end'
  | 'right-start'
  | 'left-start'

export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
}

export interface OverflowPositionOptions {
  anchor: Ref<HTMLElement | null>
  popper: Ref<HTMLElement | null>
  placement?: Placement
  /** 锚点与浮层的间距，默认 4px */
  offset?: number
  /** 视口边缘安全边距，默认 8px */
  margin?: number
  active: () => boolean
  /** 虚拟锚点矩形（如右键鼠标坐标），提供后覆盖 anchor 的几何测量 */
  getRect?: () => RectLike
}

const OPPOSITE: Record<string, string> = {
  bottom: 'top',
  top: 'bottom',
  left: 'right',
  right: 'left',
}

function flipPlacement(p: Placement): Placement {
  const [side, align] = p.split('-') as [string, string | undefined]
  const flipped = OPPOSITE[side] ?? side
  return (align ? `${flipped}-${align}` : flipped) as Placement
}

/**
 * 浮层定位：基于锚点矩形计算 fixed 坐标，视口溢出时自动翻转（bottom⇄top 等），
 * 并对最终坐标做视口钳制。ContextMenu / Dropdown / Popover / Tooltip 共用。
 */
export function useOverflowPosition(options: OverflowPositionOptions): () => void {
  const { anchor, popper } = options
  const margin = options.margin ?? 8
  const gap = options.offset ?? 4

  function anchorRect(): RectLike | null {
    return anchor.value?.getBoundingClientRect() ?? null
  }

  function compute(placement: Placement): { left: number; top: number } {
    const p = popper.value
    if (!p) return { left: -9999, top: -9999 }
    const ar = options.getRect ? options.getRect() : anchorRect()
    if (!ar) return { left: -9999, top: -9999 }
    const pw = p.offsetWidth
    const ph = p.offsetHeight
    const [side, align] = placement.split('-') as [string, string | undefined]

    let left = 0
    let top = 0
    if (side === 'bottom' || side === 'top') {
      left = align === 'end' ? ar.right - pw : ar.left
      top = side === 'bottom' ? ar.bottom + gap : ar.top - ph - gap
    } else if (side === 'right') {
      left = ar.right + gap
      top = align === 'end' ? ar.bottom - ph : ar.top
    } else {
      left = ar.left - pw - gap
      top = align === 'end' ? ar.bottom - ph : ar.top
    }

    const vw = window.innerWidth
    const vh = window.innerHeight
    const overflowsMain =
      side === 'bottom' ? top + ph + margin > vh : side === 'top' ? top - margin < 0 : false
    if (overflowsMain) {
      const flipped = computeRaw(flipPlacement(placement), ar, pw, ph)
      left = flipped.left
      top = flipped.top
    }

    left = Math.max(margin, Math.min(left, vw - pw - margin))
    top = Math.max(margin, Math.min(top, vh - ph - margin))
    return { left, top }
  }

  function computeRaw(
    placement: Placement,
    ar: RectLike,
    pw: number,
    ph: number,
  ): { left: number; top: number } {
    const [side, align] = placement.split('-') as [string, string | undefined]
    if (side === 'bottom' || side === 'top') {
      return {
        left: align === 'end' ? ar.right - pw : ar.left,
        top: side === 'bottom' ? ar.bottom + gap : ar.top - ph - gap,
      }
    }
    if (side === 'right') {
      return { left: ar.right + gap, top: align === 'end' ? ar.bottom - ph : ar.top }
    }
    return { left: ar.left - pw - gap, top: align === 'end' ? ar.bottom - ph : ar.top }
  }

  function update(): void {
    const p = popper.value
    if (!p || !options.active()) return
    const { left, top } = compute(options.placement ?? 'bottom-start')
    p.style.left = `${left}px`
    p.style.top = `${top}px`
  }

  let ro: ResizeObserver | null = null

  function bind(): void {
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    if (options.popper.value && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update)
      ro.observe(options.popper.value)
    }
  }

  function unbind(): void {
    window.removeEventListener('scroll', update, true)
    window.removeEventListener('resize', update)
    ro?.disconnect()
    ro = null
  }

  watch(options.active, (active) => {
    if (active) {
      bind()
      requestAnimationFrame(update)
    } else {
      unbind()
    }
  })

  onBeforeUnmount(unbind)

  return update
}
