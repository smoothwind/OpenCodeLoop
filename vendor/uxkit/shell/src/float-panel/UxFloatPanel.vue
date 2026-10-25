<script setup lang="ts">
import type { FloatGeom } from '@ux/composables'
import UxPanel from '../panel/UxPanel.vue'

const props = defineProps<{
  panelId: string
  title: string
  geom: FloatGeom
  z: number
}>()

const emit = defineEmits<{
  move: [id: string, x: number, y: number]
  resize: [id: string, patch: { w?: number; h?: number }]
  focus: [id: string]
  dock: [id: string]
  minimize: [id: string]
  close: [id: string]
}>()

function onHeaderPointerDown(id: string, e: PointerEvent): void {
  emit('focus', id)
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const base = { ...props.geom }
  const move = (ev: PointerEvent): void => {
    emit('move', props.panelId, base.x + ev.clientX - startX, base.y + ev.clientY - startY)
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('ux-resizing')
  }
  document.body.classList.add('ux-resizing')
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onResizePointerDown(e: PointerEvent): void {
  e.preventDefault()
  e.stopPropagation()
  emit('focus', props.panelId)
  const startX = e.clientX
  const startY = e.clientY
  const base = { ...props.geom }
  const move = (ev: PointerEvent): void => {
    emit('resize', props.panelId, { w: base.w + ev.clientX - startX, h: base.h + ev.clientY - startY })
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.classList.remove('ux-resizing')
  }
  document.body.classList.add('ux-resizing')
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <div
    class="ux-float"
    data-ux="float"
    :style="{ left: `${geom.x}px`, top: `${geom.y}px`, width: `${geom.w}px`, height: `${geom.h}px`, zIndex: z }"
    @pointerdown="emit('focus', panelId)"
  >
    <UxPanel
      :panel-id="panelId"
      :title="title"
      floating
      :draggable="false"
      @header-pointerdown="onHeaderPointerDown"
      @dock="emit('dock', $event)"
      @minimize="emit('minimize', $event)"
      @close="emit('close', $event)"
    >
      <slot />
    </UxPanel>
    <div class="ux-float__resize" aria-hidden="true" @pointerdown="onResizePointerDown" />
  </div>
</template>
