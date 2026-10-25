<script setup lang="ts">
import { computed, nextTick, ref, useSlots, watch } from 'vue'
import { UxIcon, openContextMenu } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import type { UxTabDef } from '../types'

const slots = useSlots()
/** 有 #actions 插槽时为页签栏追加右侧动作区（页签列表 / 分屏等） */
const hasActions = computed(() => !!slots.actions)

const props = defineProps<{
  items: UxTabDef[]
  activeId: string
  /** 无障碍名称（红线 10） */
  label?: string
}>()

const emit = defineEmits<{
  select: [id: string]
  close: [id: string]
  closeOthers: [id: string]
  closeRight: [id: string]
  closeLeft: [id: string]
  closeAll: []
  reorder: [fromId: string, toIndex: number]
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const dragFromId = ref<string | null>(null)
const dragOverIndex = ref(-1)
const tabRefs = ref<HTMLElement[]>([])

function focusTab(id: string): void {
  void nextTick(() => {
    const idx = props.items.findIndex((t) => t.id === id)
    tabRefs.value[idx]?.focus()
  })
}

function select(id: string): void {
  emit('select', id)
  focusTab(id)
}

function resetDrag(): void {
  dragFromId.value = null
  dragOverIndex.value = -1
}

function onDrop(index: number): void {
  const from = dragFromId.value
  resetDrag()
  if (from) emit('reorder', from, index)
}

function onContext(e: MouseEvent, id: string): void {
  e.preventDefault()
  emit('select', id)
  openContextMenu(e, [
    { id: 'close', label: tr('shell.tabs.close', '关闭'), run: () => emit('close', id) },
    { id: 'close-others', label: tr('shell.tabs.closeOthers', '关闭其他'), run: () => emit('closeOthers', id) },
    { id: 'close-right', label: tr('shell.tabs.closeRight', '关闭右侧'), run: () => emit('closeRight', id) },
    { id: 'close-left', label: tr('shell.tabs.closeLeft', '关闭左侧'), run: () => emit('closeLeft', id) },
    { id: 'sep', separator: true },
    { id: 'close-all', label: tr('shell.tabs.closeAll', '关闭全部'), danger: true, run: () => emit('closeAll') },
  ])
}

function onKeydown(e: KeyboardEvent): void {
  const n = props.items.length
  if (!n) return
  const idx = Math.max(0, props.items.findIndex((t) => t.id === props.activeId))
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    select(props.items[(idx + 1) % n].id)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    select(props.items[(idx - 1 + n) % n].id)
  } else if (e.key === 'Home') {
    e.preventDefault()
    select(props.items[0].id)
  } else if (e.key === 'End') {
    e.preventDefault()
    select(props.items[n - 1].id)
  } else if (e.key === 'Delete') {
    e.preventDefault()
    if (props.activeId) emit('close', props.activeId)
  }
}

watch(
  () => props.items.length,
  () => {
    tabRefs.value.length = props.items.length
  },
)

defineExpose({ focusTab })
</script>

<template>
  <div class="ux-tabs-host" :class="hasActions ? 'ux-tabs-host--actions' : 'ux-tabs-host--bare'">
    <div class="ux-tabs" data-ux="tabs" role="tablist" :aria-label="label ?? 'Tabs'" @keydown="onKeydown">
    <div
      v-for="(tab, i) in items"
      :key="tab.id"
      :ref="(el) => { if (el) tabRefs[i] = el as HTMLElement }"
      class="ux-tabs__tab"
      data-ux-part="tab"
      :data-ux-tab-id="tab.id"
      role="tab"
      :aria-selected="tab.id === activeId"
      :tabindex="tab.id === activeId ? 0 : -1"
      :class="{
        'is-active': tab.id === activeId,
        'is-drag-over': dragOverIndex === i && dragFromId !== tab.id,
        'is-lost': tab.status === 'lost',
        'is-off': tab.status === 'off',
      }"
      :draggable="true"
      :title="tab.subtitle ? `${tab.title} · ${tab.subtitle}` : tab.title"
      @click="select(tab.id)"
      @auxclick.middle="tab.closable !== false && emit('close', tab.id)"
      @dragstart="dragFromId = tab.id"
      @dragover.prevent="dragOverIndex = i"
      @drop.prevent="onDrop(i)"
      @dragend="resetDrag"
      @contextmenu="onContext($event, tab.id)"
    >
      <span v-if="tab.accent" class="ux-tabs__accent" :style="{ background: tab.accent }" aria-hidden="true" />
      <UxIcon v-if="tab.icon" :name="tab.icon" />
      <span class="ux-tabs__labels">
        <span class="ux-tabs__title">{{ tab.title }}</span>
        <span v-if="tab.subtitle" class="ux-tabs__subtitle">{{ tab.subtitle }}</span>
      </span>
      <span v-if="tab.dirty" class="ux-tabs__dot" :aria-label="tr('shell.tabs.dirty', '未保存')" />
      <button
        class="ux-tabs__close"
        type="button"
        :aria-label="tr('shell.tabs.close', '关闭')"
        @click.stop="emit('close', tab.id)"
        @pointerdown.stop
      >
        <UxIcon name="act-close" />
      </button>
    </div>
    </div>
    <div v-if="hasActions" class="ux-tabs__actions" data-ux-part="tabs-actions"><slot name="actions" /></div>
  </div>
</template>
