<script setup lang="ts">
import { computed, ref } from 'vue'
import { UxIcon, openContextMenu } from '@ux/components'
import { useVirtualRows } from '@ux/composables'
import { tryUseI18n } from '@ux/services'
import type { DataTableColumn } from '../types'

const props = withDefaults(
  defineProps<{
    columns: DataTableColumn[]
    /** 行矩阵（引用切片，不投影拷贝） */
    rows: unknown[][]
    rowHeight?: number
    sortable?: boolean
    /** 无障碍名称（红线 10） */
    label?: string
  }>(),
  { rowHeight: 28, sortable: true },
)

const emit = defineEmits<{
  cellContext: [payload: { row: number; col: number; value: unknown; x: number; y: number }]
  rowCopy: [row: number]
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const sortCol = ref(-1)
const sortDir = ref<'asc' | 'desc'>('asc')

function toggleSort(col: number): void {
  if (!props.sortable) return
  if (sortCol.value === col) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortCol.value = col
    sortDir.value = 'asc'
  }
}

/** 排序保持原始行号（事件上报原始索引）；null/undefined 恒排最前 */
const sorted = computed(() => {
  const indexed = props.rows.map((r, i) => ({ cells: r, index: i }))
  if (!props.sortable || sortCol.value < 0) return indexed
  const col = sortCol.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return indexed.sort((a, b) => {
    const av = a.cells[col]
    const bv = b.cells[col]
    if (av === null || av === undefined) return -dir
    if (bv === null || bv === undefined) return dir
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
})

const virtual = useVirtualRows({
  count: () => sorted.value.length,
  rowHeight: props.rowHeight,
})

const visibleRows = computed(() => sorted.value.slice(virtual.startIndex.value, virtual.endIndex.value))

const colWidths = computed(() => props.columns.map((c) => c.width ?? 160))

function display(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function ariaSort(col: number): 'ascending' | 'descending' | 'none' {
  if (sortCol.value !== col) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

function onCellContext(e: MouseEvent, row: number, col: number, value: unknown): void {
  e.preventDefault()
  emit('cellContext', { row, col, value, x: e.clientX, y: e.clientY })
}

function onHeadContext(e: MouseEvent): void {
  e.preventDefault()
  openContextMenu(e, [
    { id: 'clear-sort', label: tr('patterns.dt.clearSort', '取消排序'), disabled: sortCol.value < 0, run: () => { sortCol.value = -1 } },
  ])
}
</script>

<template>
  <div :ref="virtual.containerRef" class="ux-dt" data-ux="data-table" role="grid" :aria-label="label ?? 'Data Table'" @scroll="virtual.onScroll">
    <div class="ux-dt__head" data-ux-part="table-head" role="row" @contextmenu="onHeadContext">
      <button
        v-for="(col, ci) in columns"
        :key="col.name"
        class="ux-dt__th"
        :class="[`ux-dt__th--${col.align ?? 'left'}`, { 'is-sorted': sortCol === ci }]"
        role="columnheader"
        :aria-sort="sortable ? ariaSort(ci) : undefined"
        :style="{ width: `${colWidths[ci]}px` }"
        type="button"
        :disabled="!sortable"
        @click="toggleSort(ci)"
      >
        <span class="ux-dt__th-name">{{ col.name }}</span>
        <UxIcon
          v-if="sortable"
          name="act-chevron-down"
          class="ux-dt__sort"
          :class="{ 'ux-dt__sort--desc': sortCol === ci && sortDir === 'desc', 'ux-dt__sort--idle': sortCol !== ci }"
        />
      </button>
    </div>
    <div class="ux-dt__body" data-ux-part="table-body">
      <div class="ux-dt__spacer" :style="{ height: `${virtual.totalHeight.value}px` }">
        <div
          v-for="(row, vi) in visibleRows"
          :key="row.index"
          class="ux-dt__row"
          role="row"
          :style="{ top: `${(virtual.startIndex.value + vi) * rowHeight}px`, height: `${rowHeight}px` }"
        >
          <div
            v-for="(value, ci) in row.cells"
            :key="ci"
            class="ux-dt__td"
            :class="[`ux-dt__td--${columns[ci]?.align ?? 'left'}`, { 'is-null': value === null || value === undefined }]"
            role="gridcell"
            :style="{ width: `${colWidths[ci]}px` }"
            :title="display(value)"
            @contextmenu="onCellContext($event, row.index, ci, value)"
            @dblclick="emit('rowCopy', row.index)"
          >
            {{ display(value) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
