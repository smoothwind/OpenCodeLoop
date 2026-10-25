<script setup lang="ts">
import { computed } from 'vue'
import { getIcon, type IconId } from './registry'

const props = defineProps<{
  name: IconId
  /** 语义标签：图标不可达语义时必须提供（红线 14），提供后对读屏可见 */
  label?: string
}>()

const entry = computed(() => getIcon(props.name))
</script>

<template>
  <svg
    class="ux-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <path v-for="(d, i) in entry.paths" :key="i" :d="d" />
  </svg>
</template>
