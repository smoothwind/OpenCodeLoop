<script setup lang="ts">
import { UxBadge, UxIcon } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import type { ActivityItem } from '../types'

const props = defineProps<{
  items: ActivityItem[]
  /** 单值选中（视图切换模式）；多面板可见请用 item.active */
  activeId?: string | null
  label?: string
}>()

const emit = defineEmits<{ select: [id: string] }>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

function isActive(item: ActivityItem): boolean {
  return item.active === true || props.activeId === item.id
}

function title(item: ActivityItem): string {
  return item.pinned ? `${item.label} · ${tr('shell.activitybar.pinned', '常驻主区')}` : item.label
}

function onSelect(item: ActivityItem): void {
  if (item.pinned) return
  emit('select', item.id)
}
</script>

<template>
  <nav class="ux-activitybar" data-ux="activitybar" :aria-label="label ?? 'Activity Bar'">
    <button
      v-for="item in items"
      :key="item.id"
      class="ux-activitybar__btn"
      :class="{ 'is-active': isActive(item) }"
      type="button"
      :aria-label="title(item)"
      :aria-pressed="isActive(item)"
      :title="title(item)"
      @click="onSelect(item)"
    >
      <UxBadge v-if="item.badge" :count="item.badge" tone="danger">
        <UxIcon :name="item.icon" />
      </UxBadge>
      <UxIcon v-else :name="item.icon" />
    </button>
  </nav>
</template>
