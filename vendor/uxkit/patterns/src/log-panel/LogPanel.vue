<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { UxButton, UxChip, UxIcon, UxSegmented, type IconId, type SegmentedOption } from '@ux/components'
import type { ActivityLog, LogLevel } from '@ux/composables'
import { tryUseI18n } from '@ux/services'

const props = defineProps<{
  /** useActivityLog 实例（entries / unreadErrors / clear） */
  log: ActivityLog
  /** 无障碍名称（红线 10） */
  label?: string
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const LEVEL_ICON: Record<LogLevel, IconId> = { info: 'st-info', warn: 'st-warning', error: 'st-error' }

const level = ref<'all' | LogLevel>('all')
const levelOptions = computed<SegmentedOption[]>(() => [
  { value: 'all', label: tr('patterns.log.all', '全部') },
  { value: 'error', label: tr('patterns.log.error', '错误') },
  { value: 'warn', label: tr('patterns.log.warn', '警告') },
  { value: 'info', label: tr('patterns.log.info', '信息') },
])

const filtered = computed(() =>
  level.value === 'all' ? props.log.entries.value : props.log.entries.value.filter((e) => e.level === level.value),
)

const autoScroll = ref(true)
const listEl = ref<HTMLElement | null>(null)
const expanded = ref<Set<number>>(new Set())

function fmt(time: number): string {
  const d = new Date(time)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function toggleDetail(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function scrollToBottom(): void {
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = listEl.value
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 4
}

watch(
  () => filtered.value.length,
  () => {
    if (autoScroll.value) void nextTick(scrollToBottom)
  },
)
watch(autoScroll, (on) => {
  if (on) void nextTick(scrollToBottom)
})
watch(level, () => {
  if (autoScroll.value) void nextTick(scrollToBottom)
})

onMounted(() => {
  props.log.markOpened()
  void nextTick(scrollToBottom)
})
</script>

<template>
  <div class="ux-log" data-ux="log-panel" :aria-label="label ?? 'Activity Log'">
    <div class="ux-log__head" data-ux-part="log-head">
      <UxSegmented v-model="level" size="sm" aria-label="级别过滤" :options="levelOptions" />
      <span class="ux-spacer" />
      <UxChip tone="neutral">{{ filtered.length }}</UxChip>
      <UxButton
        size="sm"
        :variant="autoScroll ? 'secondary' : 'ghost'"
        :aria-pressed="autoScroll"
        @click="autoScroll = !autoScroll"
      >
        {{ tr('patterns.log.autoscroll', '自动滚动') }}
      </UxButton>
      <UxButton size="sm" variant="ghost" icon="act-close" :label="tr('patterns.log.clear', '清空')" @click="log.clear()" />
    </div>
    <div ref="listEl" class="ux-log__list" data-ux-part="log-body" @scroll="onScroll">
      <p v-if="!filtered.length" class="ux-log__empty">{{ tr('patterns.log.empty', '暂无日志') }}</p>
      <template v-for="e in filtered" :key="e.id">
        <div
          class="ux-log__row"
          :class="`ux-log__row--${e.level}`"
          :role="e.detail ? 'button' : undefined"
          :tabindex="e.detail ? 0 : undefined"
          @click="e.detail && toggleDetail(e.id)"
          @keydown.enter="e.detail && toggleDetail(e.id)"
          @keydown.space.prevent="e.detail && toggleDetail(e.id)"
        >
          <UxIcon :name="LEVEL_ICON[e.level]" class="ux-log__icon" />
          <span class="ux-log__time">{{ fmt(e.time) }}</span>
          <span class="ux-log__title">{{ e.title }}</span>
          <UxIcon
            v-if="e.detail"
            :name="expanded.has(e.id) ? 'act-chevron-down' : 'act-chevron-right'"
            class="ux-log__caret"
          />
        </div>
        <pre v-if="e.detail && expanded.has(e.id)" class="ux-log__detail">{{ e.detail }}</pre>
      </template>
    </div>
  </div>
</template>
