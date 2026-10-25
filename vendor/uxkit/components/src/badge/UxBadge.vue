<script setup lang="ts">
import { computed, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 计数值（>max 显示 “max+”）；不传且 dot=true 时渲染小圆点 */
    count?: number
    max?: number
    dot?: boolean
    tone?: 'accent' | 'danger' | 'success' | 'warning' | 'info' | 'neutral'
    /** 无障碍名称（红线 10）；有默认插槽时角标读屏用 */
    label?: string
  }>(),
  { max: 99, tone: 'danger' },
)

const slots = useSlots()
const hasTrigger = computed(() => !!slots.default)
const text = computed(() =>
  props.count === undefined ? '' : props.count > props.max ? `${props.max}+` : String(props.count),
)
const show = computed(() => props.dot || (props.count !== undefined && props.count > 0))
</script>

<template>
  <span v-if="hasTrigger" class="ux-badge-wrap">
    <slot />
    <span
      v-if="show"
      class="ux-badge ux-badge--corner"
      :class="[`ux-badge--${tone}`, { 'ux-badge--dot': dot }]"
      :aria-label="label"
      :aria-hidden="label ? undefined : 'true'"
    >
      <template v-if="!dot">{{ text }}</template>
    </span>
  </span>
  <span
    v-else-if="show"
    class="ux-badge"
    :class="[`ux-badge--${tone}`, { 'ux-badge--dot': dot }]"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <template v-if="!dot">{{ text }}</template>
  </span>
</template>
