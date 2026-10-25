<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useHoverIntent, useOverflowPosition, type Placement } from '@ux/composables'

const props = withDefaults(
  defineProps<{
    /** 提示文本；为空则不显示 */
    content?: string
    placement?: Placement
    /** hover 意图延迟（ms），避免掠过闪烁 */
    delay?: number
    disabled?: boolean
  }>(),
  { placement: 'top', delay: 120 },
)

const triggerEl = ref<HTMLElement | null>(null)
const tipEl = ref<HTMLElement | null>(null)
const open = ref(false)
const tipId = `ux-tip-${Math.random().toString(36).slice(2, 8)}`
const { schedule, cancel } = useHoverIntent(props.delay)

const updatePosition = useOverflowPosition({
  anchor: triggerEl,
  popper: tipEl,
  placement: props.placement,
  offset: 6,
  active: () => open.value,
})

function show(delayed: boolean): void {
  if (props.disabled || !props.content) return
  if (delayed) schedule(() => (open.value = true))
  else {
    cancel()
    open.value = true
  }
}

function hide(): void {
  cancel()
  open.value = false
}

function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') hide()
}

watch(open, (value) => {
  if (value) {
    requestAnimationFrame(updatePosition)
    document.addEventListener('keydown', onDocKeydown, true)
  } else {
    document.removeEventListener('keydown', onDocKeydown, true)
  }
})

onBeforeUnmount(() => document.removeEventListener('keydown', onDocKeydown, true))
</script>

<template>
  <span
    ref="triggerEl"
    class="ux-tip-trigger"
    :aria-describedby="open && content ? tipId : undefined"
    @mouseenter="show(true)"
    @mouseleave="hide"
    @focusin="show(false)"
    @focusout="hide"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div v-if="open" :id="tipId" ref="tipEl" class="ux-tip" role="tooltip">{{ content }}</div>
  </Teleport>
</template>
