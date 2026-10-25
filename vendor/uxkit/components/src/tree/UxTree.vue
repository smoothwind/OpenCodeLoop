<script setup lang="ts">
import { computed, ref } from 'vue'
import UxIcon from '../icon/UxIcon.vue'
import type {
  DropPosition,
  NodeContextMenuPayload,
  NodeDblclickPayload,
  NodeMovePayload,
  TreeNodeData,
} from './types'

const props = withDefaults(
  defineProps<{
    items: TreeNodeData[]
    /** 当前选中节点 id（v-model） */
    modelValue?: string | null
    /** 展开节点 id 集合（v-model:expanded，纯受控） */
    expanded?: string[]
    /** 搜索过滤：命中节点的祖先链保留并强制展开显示 */
    filter?: string
    /** 懒加载：展开 children 为 undefined 的非叶节点时调用，结果缓存于组件内部 */
    lazyLoad?: (node: TreeNodeData) => Promise<TreeNodeData[]>
    /** 拖拽防守式校验：返回 false 拒绝投放（组件另自查：拖到自身/自身子孙必拒） */
    canDrop?: (dragId: string, targetId: string, position: DropPosition) => boolean
    /** 无障碍名称（红线 10） */
    ariaLabel?: string
  }>(),
  { modelValue: null, expanded: () => [], filter: '' },
)

const emit = defineEmits<{
  'update:modelValue': [id: string]
  'update:expanded': [ids: string[]]
  'node-contextmenu': [payload: NodeContextMenuPayload]
  'node-move': [payload: NodeMovePayload]
  'node-dblclick': [payload: NodeDblclickPayload]
}>()

/** 懒加载结果缓存（组件内持有，不回写 props.items——数据单向） */
const lazyCache = ref(new Map<string, TreeNodeData[]>())
const loadingIds = ref(new Set<string>())

const expandedSet = computed(() => new Set(props.expanded))
const filterKey = computed(() => props.filter.trim().toLowerCase())

function childrenOf(node: TreeNodeData): TreeNodeData[] | undefined {
  return lazyCache.value.get(node.id) ?? node.children
}

function hasChildren(node: TreeNodeData): boolean {
  if (node.leaf) return false
  const children = childrenOf(node)
  if (children === undefined) return Boolean(props.lazyLoad)
  return children.length > 0
}

/** 过滤判定：自身命中或任一后代命中则保留 */
function keep(node: TreeNodeData): boolean {
  if (!filterKey.value) return true
  if (node.label.toLowerCase().includes(filterKey.value)) return true
  return (childrenOf(node) ?? []).some((child) => keep(child))
}

interface FlatRow {
  node: TreeNodeData
  depth: number
  parentId: string | null
  expanded: boolean
  expandable: boolean
  loading: boolean
}

const flatRows = computed<FlatRow[]>(() => {
  const rows: FlatRow[] = []
  const walk = (nodes: TreeNodeData[], depth: number, parentId: string | null): void => {
    for (const node of nodes) {
      if (!keep(node)) continue
      const expandable = hasChildren(node)
      const loading = loadingIds.value.has(node.id)
      // 过滤态强制展开（否则看不到命中后代）；懒加载中视为展开以显示 loading 行
      const expanded =
        expandable && (filterKey.value !== '' || expandedSet.value.has(node.id) || loading)
      rows.push({ node, depth, parentId, expanded, expandable, loading })
      if (expandable && expanded) walk(loading ? [] : childrenOf(node) ?? [], depth + 1, node.id)
    }
  }
  walk(props.items, 0, null)
  return rows
})

const selectedId = computed(() => props.modelValue)
/** roving tabindex：选中项承载，无选中回落首个可见项 */
const tabbableId = computed(() => selectedId.value ?? flatRows.value[0]?.node.id ?? null)

function visibleIndex(id: string): number {
  return flatRows.value.findIndex((row) => row.node.id === id)
}

function focusRow(id: string): void {
  rootEl.value
    ?.querySelector<HTMLElement>(`[data-ux-tree-id="${CSS.escape(id)}"]`)
    ?.focus()
}

function toggleExpand(node: TreeNodeData): void {
  if (node.disabled || !hasChildren(node) || loadingIds.value.has(node.id)) return
  if (childrenOf(node) === undefined && props.lazyLoad) {
    void loadChildren(node)
    return
  }
  const next = new Set(props.expanded)
  if (next.has(node.id)) next.delete(node.id)
  else next.add(node.id)
  emit('update:expanded', [...next])
}

async function loadChildren(node: TreeNodeData): Promise<void> {
  const loading = new Set(loadingIds.value)
  loading.add(node.id)
  loadingIds.value = loading
  if (!expandedSet.value.has(node.id)) {
    emit('update:expanded', [...props.expanded, node.id])
  }
  try {
    const children = await props.lazyLoad!(node)
    const cache = new Map(lazyCache.value)
    cache.set(node.id, children ?? [])
    lazyCache.value = cache
  } finally {
    const done = new Set(loadingIds.value)
    done.delete(node.id)
    loadingIds.value = done
  }
}

function select(id: string): void {
  const row = flatRows.value[visibleIndex(id)]
  if (!row || row.node.disabled) return
  emit('update:modelValue', id)
}

function focusMove(fromId: string | null, delta: 1 | -1): void {
  const total = flatRows.value.length
  if (!total) return
  let idx = fromId ? visibleIndex(fromId) : delta > 0 ? -1 : total
  for (let step = 0; step < total; step++) {
    idx = (idx + delta + total) % total
    focusRow(flatRows.value[idx].node.id)
    return
  }
}

function onKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const id = target?.dataset?.uxTreeId
  if (!id) return
  const row = flatRows.value[visibleIndex(id)]
  if (!row) return
  const k = e.key
  if (k === 'ArrowDown') {
    e.preventDefault()
    focusMove(id, 1)
  } else if (k === 'ArrowUp') {
    e.preventDefault()
    focusMove(id, -1)
  } else if (k === 'ArrowRight') {
    e.preventDefault()
    if (row.expandable && !row.expanded) toggleExpand(row.node)
    else if (row.expanded) {
      const child = flatRows.value[visibleIndex(id) + 1]
      if (child && child.parentId === id) focusRow(child.node.id)
    }
  } else if (k === 'ArrowLeft') {
    e.preventDefault()
    if (row.expanded && filterKey.value === '') toggleExpand(row.node)
    else if (row.parentId) focusRow(row.parentId)
  } else if (k === 'Home') {
    e.preventDefault()
    const first = flatRows.value[0]
    if (first) focusRow(first.node.id)
  } else if (k === 'End') {
    e.preventDefault()
    focusMove(null, -1)
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault()
    select(id)
  } else if (k.length === 1 && /\S/.test(k)) {
    const ch = k.toLowerCase()
    const total = flatRows.value.length
    const start = visibleIndex(id)
    for (let step = 1; step <= total; step++) {
      const candidate = flatRows.value[(start + step) % total]
      if (candidate.node.label.toLowerCase().startsWith(ch)) {
        focusRow(candidate.node.id)
        return
      }
    }
  }
}

/** ---- 拖拽（防守式校验）---- */
const dragId = ref<string | null>(null)
const dropMarker = ref<{ id: string; position: DropPosition } | null>(null)

/** targetId 是否位于 ancestorId 子树内（ancestor 自身不算） */
function isDescendant(ancestorId: string, targetId: string): boolean {
  const walk = (nodes: TreeNodeData[], inside: boolean): boolean => {
    for (const node of nodes) {
      if (node.id === targetId && inside) return true
      const children = childrenOf(node)
      if (children && walk(children, inside || node.id === ancestorId)) return true
    }
    return false
  }
  return walk(props.items, false)
}

function dropPositionOf(e: DragEvent): DropPosition {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / rect.height
  if (ratio < 0.25) return 'before'
  if (ratio > 0.75) return 'after'
  return 'inside'
}

function allowed(targetId: string, position: DropPosition): boolean {
  const from = dragId.value
  if (!from) return false
  if (from === targetId) return false
  if (position === 'inside' && isDescendant(from, targetId)) return false
  if (props.canDrop && !props.canDrop(from, targetId, position)) return false
  return true
}

function onDragStart(e: DragEvent, node: TreeNodeData): void {
  if (node.disabled) {
    e.preventDefault()
    return
  }
  dragId.value = node.id
  e.dataTransfer?.setData('text/ux-tree-node', node.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, node: TreeNodeData): void {
  if (!dragId.value) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const position = dropPositionOf(e)
  dropMarker.value = allowed(node.id, position) ? { id: node.id, position } : null
}

function onDrop(e: DragEvent, node: TreeNodeData): void {
  e.preventDefault()
  const marker = dropMarker.value
  if (dragId.value && marker && marker.id === node.id) {
    emit('node-move', { dragId: dragId.value, targetId: node.id, position: marker.position })
  }
  dragId.value = null
  dropMarker.value = null
}

function onDragEnd(): void {
  dragId.value = null
  dropMarker.value = null
}

function onContextmenu(e: MouseEvent, node: TreeNodeData): void {
  e.preventDefault()
  emit('node-contextmenu', { node, x: e.clientX, y: e.clientY })
}

function onDblclick(e: MouseEvent, node: TreeNodeData): void {
  emit('node-dblclick', { node, event: e })
  toggleExpand(node)
}

const rootEl = ref<HTMLElement | null>(null)
</script>

<template>
  <div
    ref="rootEl"
    class="ux-tree"
    data-ux="tree"
    role="tree"
    :aria-label="ariaLabel"
    @keydown="onKeydown"
  >
    <div
      v-for="row in flatRows"
      :key="row.node.id"
      class="ux-tree__row"
      :class="{
        'is-selected': row.node.id === selectedId,
        'is-disabled': row.node.disabled,
        'is-drop-before': dropMarker?.id === row.node.id && dropMarker.position === 'before',
        'is-drop-after': dropMarker?.id === row.node.id && dropMarker.position === 'after',
        'is-drop-inside': dropMarker?.id === row.node.id && dropMarker.position === 'inside',
      }"
      :style="{ paddingLeft: `calc(${row.depth} * var(--ux-sp-4))` }"
      role="treeitem"
      :data-ux-tree-id="row.node.id"
      :aria-level="row.depth + 1"
      :aria-expanded="row.expandable ? row.expanded : undefined"
      :aria-selected="row.node.id === selectedId"
      :aria-disabled="row.node.disabled ? 'true' : undefined"
      :tabindex="row.node.id === tabbableId ? 0 : -1"
      :draggable="!row.node.disabled"
      @click="select(row.node.id)"
      @dblclick="onDblclick($event, row.node)"
      @contextmenu="onContextmenu($event, row.node)"
      @dragstart="onDragStart($event, row.node)"
      @dragover="onDragOver($event, row.node)"
      @drop="onDrop($event, row.node)"
      @dragend="onDragEnd"
    >
      <span class="ux-tree__twist" @click.stop="toggleExpand(row.node)">
        <UxIcon v-if="row.loading" name="act-retry" class="ux-tree__spinner" />
        <UxIcon
          v-else-if="row.expandable"
          name="act-chevron-right"
          class="ux-tree__chevron"
          :class="{ 'is-open': row.expanded }"
        />
      </span>
      <UxIcon
        v-if="row.node.icon"
        :name="row.node.icon"
        class="ux-tree__icon"
        :class="`is-${row.node.status ?? 'on'}`"
      />
      <span class="ux-tree__label">{{ row.node.label }}</span>
      <span v-if="row.node.badge" class="ux-tree__badge">{{ row.node.badge > 99 ? '99+' : row.node.badge }}</span>
      <span v-if="row.node.status === 'lost'" class="ux-tree__dot" />
    </div>
  </div>
</template>
