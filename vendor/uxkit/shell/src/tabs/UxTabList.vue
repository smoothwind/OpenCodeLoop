<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { UxIcon, UxInput } from '@ux/components'
import { useDismiss, useOverflowPosition } from '@ux/composables'
import { tryUseI18n } from '@ux/services'
import type { UxTabDef } from '../types'

const props = defineProps<{
  items: UxTabDef[]
  activeId: string
  /** 无障碍名称（红线 10） */
  label?: string
}>()

const emit = defineEmits<{
  select: [id: string]
  close: [id: string]
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const open = ref(false)
const query = ref('')
const cursor = ref(0)
const triggerEl = ref<HTMLElement | null>(null)
const popEl = ref<HTMLElement | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.items
  return props.items.filter(
    (t) => (t.title ?? '').toLowerCase().includes(q) || (t.subtitle ?? '').toLowerCase().includes(q),
  )
})

const updatePosition = useOverflowPosition({
  anchor: triggerEl,
  popper: popEl,
  placement: 'bottom-end',
  offset: 4,
  active: () => open.value,
})

useDismiss({
  active: () => open.value,
  onDismiss: () => (open.value = false),
  ignore: () => [triggerEl.value, popEl.value],
})

function show(): void {
  query.value = ''
  cursor.value = Math.max(0, props.items.findIndex((t) => t.id === props.activeId))
  open.value = true
  void nextTick(() => {
    updatePosition()
    popEl.value?.querySelector<HTMLInputElement>('input')?.focus()
  })
}

function hide(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) hide()
  else show()
}

function pick(id: string): void {
  emit('select', id)
  hide()
}

function closeTab(e: MouseEvent, id: string): void {
  e.stopPropagation()
  emit('close', id)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    cursor.value = Math.min(filtered.value.length - 1, cursor.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    cursor.value = Math.max(0, cursor.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const tab = filtered.value[cursor.value]
    if (tab) pick(tab.id)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    hide()
  }
}
</script>

<template>
  <button
    ref="triggerEl"
    class="ux-tablist__trigger"
    type="button"
    :aria-label="label ?? tr('shell.tabList.label', '页签列表')"
    :title="label ?? tr('shell.tabList.label', '页签列表')"
    aria-haspopup="true"
    :aria-expanded="open"
    @click="toggle"
  >
    <UxIcon name="act-tab-list" />
    <span class="ux-tablist__count">{{ items.length }}</span>
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popEl"
      class="ux-tablist"
      data-ux="tab-list"
      :aria-label="label ?? tr('shell.tabList.label', '页签列表')"
      @keydown="onKeydown"
    >
      <div class="ux-tablist__search">
        <UxInput v-model="query" :label="tr('shell.tabList.filter', '过滤页签')" />
      </div>
      <ul class="ux-tablist__list">
        <li v-if="!filtered.length" class="ux-tablist__empty">{{ tr('shell.tabList.empty', '无匹配页签') }}</li>
        <li
          v-for="(t, i) in filtered"
          :key="t.id"
          class="ux-tablist__item"
          :class="{ 'is-active': t.id === activeId, 'is-cursor': i === cursor }"
          :aria-current="t.id === activeId ? 'true' : undefined"
          @mousemove="cursor = i"
          @click="pick(t.id)"
        >
          <span v-if="t.accent" class="ux-tablist__accent" :style="{ background: t.accent }" aria-hidden="true" />
          <UxIcon v-if="t.icon" :name="t.icon" />
          <span class="ux-tablist__labels">
            <span class="ux-tablist__title">{{ t.title }}</span>
            <span v-if="t.subtitle" class="ux-tablist__subtitle">{{ t.subtitle }}</span>
          </span>
          <button
            class="ux-tablist__close"
            type="button"
            :aria-label="tr('shell.tabs.close', '关闭')"
            @click="(e) => closeTab(e, t.id)"
          >
            <UxIcon name="act-close" />
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
