<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { UxIcon } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import type { SettingsCategory } from '../types'

const props = defineProps<{
  categories: SettingsCategory[]
  activeId: string
  /** 无障碍名称（红线 10） */
  label?: string
}>()

const emit = defineEmits<{ select: [id: string] }>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const btnRefs = ref<HTMLElement[]>([])

function select(id: string): void {
  emit('select', id)
  void nextTick(() => {
    const idx = props.categories.findIndex((c) => c.id === id)
    btnRefs.value[idx]?.focus()
  })
}

function onKeydown(e: KeyboardEvent): void {
  const n = props.categories.length
  if (!n) return
  const idx = Math.max(0, props.categories.findIndex((c) => c.id === props.activeId))
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    select(props.categories[(idx + 1) % n].id)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    select(props.categories[(idx - 1 + n) % n].id)
  } else if (e.key === 'Home') {
    e.preventDefault()
    select(props.categories[0].id)
  } else if (e.key === 'End') {
    e.preventDefault()
    select(props.categories[n - 1].id)
  }
}
</script>

<template>
  <div class="ux-settings" data-ux="settings">
    <nav class="ux-settings__nav" data-ux-part="settings-nav" :aria-label="label ?? 'Settings'" @keydown="onKeydown">
      <button
        v-for="(cat, i) in categories"
        :key="cat.id"
        :ref="(el) => { if (el) btnRefs[i] = el as HTMLElement }"
        class="ux-settings__item"
        type="button"
        :aria-current="cat.id === activeId ? 'true' : undefined"
        :class="{ 'is-active': cat.id === activeId }"
        @click="select(cat.id)"
      >
        <UxIcon v-if="cat.icon" :name="cat.icon" />
        <span>{{ cat.label }}</span>
      </button>
    </nav>
    <div class="ux-settings__content" data-ux-part="settings-content">
      <div class="ux-settings__panel">
        <slot :active-id="activeId" />
      </div>
      <p class="ux-settings__footnote">{{ tr('patterns.settings.liveHint', '更改即时生效') }}</p>
    </div>
  </div>
</template>
