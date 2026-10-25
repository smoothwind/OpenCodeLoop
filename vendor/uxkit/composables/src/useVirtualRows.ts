import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface VirtualRowsOptions {
  /** 总行数（getter：内部为响应式计算，依赖会自动追踪） */
  count: () => number
  /** 固定行高（px） */
  rowHeight: number
  /** 视口上下额外渲染行数 */
  overscan?: number
}

/**
 * 固定行高虚拟滚动窗口（固定行高方案：偏移量纯乘法，无动态测量）。
 * 返回可视区间 [startIndex, endIndex) 与占位高度；容器需 overflow 滚动。
 */
export function useVirtualRows(options: VirtualRowsOptions) {
  const containerRef = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewport = ref(0)
  let observer: ResizeObserver | null = null
  let raf = 0

  function measure(): void {
    viewport.value = containerRef.value?.clientHeight ?? 0
  }

  function onScroll(): void {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      scrollTop.value = containerRef.value?.scrollTop ?? 0
    })
  }

  onMounted(() => {
    measure()
    observer = new ResizeObserver(measure)
    if (containerRef.value) observer.observe(containerRef.value)
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
    cancelAnimationFrame(raf)
  })

  const startIndex = computed(() => {
    const over = options.overscan ?? 6
    return Math.max(0, Math.floor(scrollTop.value / options.rowHeight) - over)
  })

  const endIndex = computed(() => {
    const over = options.overscan ?? 6
    const visible = Math.ceil(viewport.value / options.rowHeight) + 1
    return Math.min(options.count(), startIndex.value + visible + over * 2)
  })

  /** 顶部占位高度（把窗口推到滚动位置对应处） */
  const padTop = computed(() => startIndex.value * options.rowHeight)
  /** 总内容高度（撑出真实滚动条） */
  const totalHeight = computed(() => options.count() * options.rowHeight)

  return { containerRef, startIndex, endIndex, padTop, totalHeight, onScroll }
}
