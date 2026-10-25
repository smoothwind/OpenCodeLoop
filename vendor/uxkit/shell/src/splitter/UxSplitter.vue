<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: number
    orientation?: 'vertical' | 'horizontal'
    min?: number
    max?: number
    /** 反向：位于中心区右侧/下方时，指针位移取反 */
    reverse?: boolean
    /** 键盘步进，Shift 加速 4× */
    step?: number
    /** 无障碍名称（红线 10：必须提供） */
    label?: string
  }>(),
  { orientation: 'vertical', min: 120, max: 800, step: 8 },
)

const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

function clamp(value: number): number {
  return Math.min(props.max, Math.max(props.min, Math.round(value)))
}
function commit(value: number): void {
  emit('update:modelValue', clamp(value))
}

function onPointerDown(e: PointerEvent): void {
  e.preventDefault()
  const el = e.currentTarget as HTMLElement
  el.focus()
  const startPos = props.orientation === 'vertical' ? e.clientX : e.clientY
  const base = props.modelValue
  const dir = props.reverse ? -1 : 1

  const move = (ev: PointerEvent): void => {
    const pos = props.orientation === 'vertical' ? ev.clientX : ev.clientY
    commit(base + (pos - startPos) * dir)
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('ux-resizing', `ux-resizing--${props.orientation}`)
  }
  document.body.classList.add('ux-resizing', `ux-resizing--${props.orientation}`)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onKeydown(e: KeyboardEvent): void {
  const step = props.step * (e.shiftKey ? 4 : 1)
  const dir = props.reverse ? -1 : 1
  const dec = props.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp'
  const inc = props.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown'
  if (e.key === dec) {
    e.preventDefault()
    commit(props.modelValue - step * dir)
  } else if (e.key === inc) {
    e.preventDefault()
    commit(props.modelValue + step * dir)
  } else if (e.key === 'Home') {
    e.preventDefault()
    commit(props.min)
  } else if (e.key === 'End') {
    e.preventDefault()
    commit(props.max)
  }
}
</script>

<template>
  <div
    class="ux-splitter"
    data-ux="splitter"
    :class="`ux-splitter--${orientation}`"
    role="separator"
    tabindex="0"
    :aria-orientation="orientation"
    :aria-valuenow="modelValue"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-label="label"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
  />
</template>
