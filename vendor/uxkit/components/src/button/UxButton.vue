<script setup lang="ts">
import { computed, useSlots } from 'vue'
import UxIcon from '../icon/UxIcon.vue'
import type { IconId } from '../icon/registry'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    icon?: IconId
    loading?: boolean
    disabled?: boolean
    /** 语义标签：仅图标按钮必填（红线 14），同时作为 tooltip */
    label?: string
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)

const slots = useSlots()
/** 允许宿主用 #icon 插槽提供非注册表图标（如 lucide 领域字形），仍获得 UxKit 按钮样式 */
const hasIcon = computed(() => !!props.icon || !!slots.icon)
const iconOnly = computed(() => hasIcon.value && !slots.default)

if (import.meta.env?.DEV && iconOnly.value && !props.label) {
  console.warn('[UxButton] 仅图标按钮必须提供 label（红线 14：图标达意不足需配文字）')
}
</script>

<template>
  <button
    class="ux-btn"
    :class="[`ux-btn--${variant}`, `ux-btn--${size}`, { 'ux-btn--icon-only': iconOnly }]"
    :type="type"
    :disabled="disabled || loading"
    :aria-label="iconOnly ? label : undefined"
    :title="label"
  >
    <span v-if="loading" class="ux-btn__spinner" aria-hidden="true" />
    <span v-else-if="slots.icon" class="ux-btn__icon"><slot name="icon" /></span>
    <UxIcon v-else-if="icon" :name="icon" />
    <span v-if="slots.default" class="ux-btn__text"><slot /></span>
  </button>
</template>
