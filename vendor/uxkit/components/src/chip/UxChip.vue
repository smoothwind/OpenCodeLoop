<script setup lang="ts">
withDefaults(
  defineProps<{
    tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
    /** 前置状态圆点（同 tone 着色） */
    dot?: boolean
  }>(),
  { tone: 'neutral' },
)
</script>

<template>
  <span class="ux-chip" :class="`ux-chip--${tone}`">
    <span v-if="dot" class="ux-chip__dot" aria-hidden="true" />
    <slot />
  </span>
</template>
