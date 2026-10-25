<script setup lang="ts">
import { computed, ref } from 'vue'
import UxIcon from '../icon/UxIcon.vue'
import type { SegmentedOption } from './types'

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: string
    options: SegmentedOption[]
    size?: 'sm' | 'md'
    disabled?: boolean
    /** 无障碍名称（红线 10） */
    ariaLabel?: string
  }>(),
  { size: 'md' },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const groupEl = ref<HTMLElement | null>(null)

const enabled = computed(() => props.options.filter((o) => !o.disabled))
const activeIndex = computed(() => enabled.value.findIndex((o) => o.value === props.modelValue))
/** 选中项不可用时（或为空）回落首个可用项承载 tabindex（roving） */
const tabbableValue = computed(() => {
  if (activeIndex.value >= 0) return props.modelValue
  return enabled.value[0]?.value
})

function select(value: string, disabled?: boolean): void {
  if (props.disabled || disabled || value === props.modelValue) return
  emit('update:modelValue', value)
}

function focusEnabled(index: number): void {
  const buttons = groupEl.value?.querySelectorAll<HTMLButtonElement>('.ux-seg__item:not(:disabled)')
  buttons?.[index]?.focus()
}

function move(delta: number): void {
  const list = enabled.value
  if (!list.length) return
  const cur = activeIndex.value
  const base = cur < 0 ? (delta > 0 ? -1 : 0) : cur
  const next = (base + delta + list.length) % list.length
  select(list[next].value)
  focusEnabled(next)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    const first = enabled.value[0]
    if (first) {
      select(first.value)
      focusEnabled(0)
    }
  } else if (e.key === 'End') {
    e.preventDefault()
    const last = enabled.value[enabled.value.length - 1]
    if (last) {
      select(last.value)
      focusEnabled(enabled.value.length - 1)
    }
  }
}
</script>

<template>
  <div
    ref="groupEl"
    class="ux-seg"
    :class="`ux-seg--${size}`"
    role="radiogroup"
    :aria-label="ariaLabel"
    :aria-disabled="disabled ? 'true' : undefined"
    @keydown="onKeydown"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      class="ux-seg__item"
      :class="{ 'is-active': opt.value === modelValue }"
      type="button"
      role="radio"
      :aria-checked="opt.value === modelValue"
      :aria-label="opt.ariaLabel"
      :title="opt.ariaLabel ?? opt.label"
      :disabled="disabled || opt.disabled"
      :tabindex="opt.value === tabbableValue ? 0 : -1"
      @click="select(opt.value, opt.disabled)"
    >
      <UxIcon v-if="opt.icon" :name="opt.icon" />
      <span v-if="opt.label">{{ opt.label }}</span>
    </button>
  </div>
</template>
