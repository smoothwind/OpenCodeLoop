<script setup lang="ts">
import type { IconId } from '@ux/components'
import { UxIcon } from '@ux/components'

defineProps<{
  /** 图标语义唯一（红线 13）：一般用 obj-* 对象图标 */
  icon?: IconId
  title: string
  hint?: string
  compact?: boolean
}>()
</script>

<template>
  <div class="ux-empty" data-ux="empty" :class="{ 'ux-empty--compact': compact }">
    <UxIcon v-if="icon" :name="icon" class="ux-empty__icon" />
    <div class="ux-empty__title">{{ title }}</div>
    <div v-if="hint" class="ux-empty__hint">{{ hint }}</div>
    <div v-if="$slots.action" class="ux-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>
