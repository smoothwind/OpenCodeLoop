<script setup lang="ts">
import { UxIcon } from '@ux/components'
import { tryUseI18n } from '@ux/services'

const props = withDefaults(
  defineProps<{
    panelId: string
    title: string
    /** 停靠态：头部可拖拽换区（HTML5 DnD） */
    draggable?: boolean
    /** 悬浮态：头部改为指针拖动，显示最小化按钮 */
    floating?: boolean
    /** 显示关闭按钮 */
    closable?: boolean
    /** 显示 停靠/悬浮 切换按钮 */
    dockable?: boolean
  }>(),
  { draggable: true, closable: true, dockable: true },
)

const emit = defineEmits<{
  dragstart: [id: string]
  dragend: [id: string]
  'header-pointerdown': [id: string, event: PointerEvent]
  dblclick: [id: string]
  dock: [id: string]
  float: [id: string]
  minimize: [id: string]
  close: [id: string]
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

function onDragStart(e: DragEvent): void {
  e.dataTransfer?.setData('text/plain', props.panelId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  emit('dragstart', props.panelId)
}

function onHeaderPointerDown(e: PointerEvent): void {
  if (!props.floating) return
  if ((e.target as HTMLElement).closest('button')) return
  emit('header-pointerdown', props.panelId, e)
}
</script>

<template>
  <section class="ux-panel" :class="{ 'ux-panel--floating': floating }" data-ux="panel">
    <header
      class="ux-panel__head"
      data-ux-part="panel-head"
      :draggable="draggable && !floating"
      @dragstart="onDragStart"
      @dragend="emit('dragend', panelId)"
      @pointerdown="onHeaderPointerDown"
      @dblclick="emit('dblclick', panelId)"
    >
      <span class="ux-panel__title">{{ title }}</span>
      <div class="ux-panel__actions">
        <slot name="actions" />
        <button
          v-if="dockable"
          class="ux-panel__btn"
          type="button"
          :aria-label="floating ? tr('shell.panel.dock', '停靠') : tr('shell.panel.float', '悬浮')"
          :title="floating ? tr('shell.panel.dock', '停靠') : tr('shell.panel.float', '悬浮')"
          @click="floating ? emit('dock', panelId) : emit('float', panelId)"
        >
          <UxIcon :name="floating ? 'act-dock' : 'act-float'" />
        </button>
        <button
          v-if="floating"
          class="ux-panel__btn"
          type="button"
          :aria-label="tr('shell.panel.minimize', '最小化')"
          :title="tr('shell.panel.minimize', '最小化')"
          @click="emit('minimize', panelId)"
        >
          <UxIcon name="act-window-minimize" />
        </button>
        <button
          v-if="closable"
          class="ux-panel__btn"
          type="button"
          :aria-label="tr('shell.panel.close', '关闭')"
          :title="tr('shell.panel.close', '关闭')"
          @click="emit('close', panelId)"
        >
          <UxIcon name="act-close" />
        </button>
      </div>
    </header>
    <div class="ux-panel__body" data-ux-part="panel-body"><slot /></div>
  </section>
</template>
