<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DockLayout, DockZone } from '@ux/composables'
import { UxIcon } from '@ux/components'
import { tryUseI18n } from '@ux/services'
import type { DockPanelDef } from '../types'
import UxFloatPanel from '../float-panel/UxFloatPanel.vue'
import UxPanel from '../panel/UxPanel.vue'
import UxSplitter from '../splitter/UxSplitter.vue'

const props = defineProps<{
  layout: DockLayout
  panels: DockPanelDef[]
}>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const hoverZone = ref<DockZone | 'float' | null>(null)

/** 经 resizeZone 写入（含钳制），避免直改 prop 深层属性 */
const leftSize = computed({
  get: () => props.layout.sizes.left,
  set: (v: number) => props.layout.resizeZone('left', v),
})
const rightSize = computed({
  get: () => props.layout.sizes.right,
  set: (v: number) => props.layout.resizeZone('right', v),
})
const bottomSize = computed({
  get: () => props.layout.sizes.bottom,
  set: (v: number) => props.layout.resizeZone('bottom', v),
})

const draggingId = computed(() => props.layout.dragging.value)
const leftPanel = computed(() => props.layout.panelInZone('left'))
const rightPanel = computed(() => props.layout.panelInZone('right'))
const bottomPanel = computed(() => props.layout.panelInZone('bottom'))
const floatCards = computed(() => props.layout.floating.value.filter((id) => !props.layout.isMinimized(id)))
const minimizedCards = computed(() => props.layout.floating.value.filter((id) => props.layout.isMinimized(id)))

function titleOf(id: string): string {
  return props.panels.find((p) => p.id === id)?.title ?? id
}

function onDragStart(id: string): void {
  props.layout.beginDrag(id)
  hoverZone.value = null
}

function onDragEnd(): void {
  props.layout.endDrag()
  hoverZone.value = null
}

function dropOn(zone: DockZone | 'float'): void {
  const id = props.layout.dragging.value
  if (id) {
    if (zone === 'float') props.layout.float(id)
    else props.layout.dock(id, zone)
  }
  props.layout.endDrag()
  hoverZone.value = null
}
</script>

<template>
  <div class="ux-dock" data-ux="dock">
    <div v-if="$slots.activity" class="ux-dock__activity" data-ux-part="activity">
      <slot name="activity" />
    </div>

    <div class="ux-dock__main">
      <div class="ux-dock__row">
        <div v-if="leftPanel" class="ux-dock__side" data-ux-part="dock-left" :style="{ width: `${layout.sizes.left}px` }">
          <UxPanel
            :panel-id="leftPanel"
            :title="titleOf(leftPanel)"
            @dragstart="onDragStart"
            @dragend="onDragEnd"
            @dblclick="layout.float($event)"
            @float="layout.float($event)"
            @close="layout.hide($event)"
          >
            <slot name="panel" :id="leftPanel" />
          </UxPanel>
        </div>
        <UxSplitter
          v-if="leftPanel"
          v-model="leftSize"
          orientation="vertical"
          :min="layout.limits.left[0]"
          :max="layout.limits.left[1]"
          :label="tr('shell.splitter.left', '调整左侧栏宽度')"
        />

        <div class="ux-dock__center" data-ux-part="dock-center">
          <slot name="center" />
        </div>

        <UxSplitter
          v-if="rightPanel"
          v-model="rightSize"
          orientation="vertical"
          reverse
          :min="layout.limits.right[0]"
          :max="layout.limits.right[1]"
          :label="tr('shell.splitter.right', '调整右侧栏宽度')"
        />
        <div
          v-if="rightPanel"
          class="ux-dock__side ux-dock__side--right"
          data-ux-part="dock-right"
          :style="{ width: `${layout.sizes.right}px` }"
        >
          <UxPanel
            :panel-id="rightPanel"
            :title="titleOf(rightPanel)"
            @dragstart="onDragStart"
            @dragend="onDragEnd"
            @dblclick="layout.float($event)"
            @float="layout.float($event)"
            @close="layout.hide($event)"
          >
            <slot name="panel" :id="rightPanel" />
          </UxPanel>
        </div>
      </div>

      <UxSplitter
        v-if="bottomPanel"
        v-model="bottomSize"
        orientation="horizontal"
        :min="layout.limits.bottom[0]"
        :max="layout.limits.bottom[1]"
        :label="tr('shell.splitter.bottom', '调整底部面板高度')"
      />
      <div
        v-if="bottomPanel"
        class="ux-dock__bottom"
        data-ux-part="dock-bottom"
        :style="{ height: `${layout.sizes.bottom}px` }"
      >
        <UxPanel
          :panel-id="bottomPanel"
          :title="titleOf(bottomPanel)"
          @dragstart="onDragStart"
          @dragend="onDragEnd"
          @dblclick="layout.float($event)"
          @float="layout.float($event)"
          @close="layout.hide($event)"
        >
          <slot name="panel" :id="bottomPanel" />
        </UxPanel>
      </div>
    </div>

    <div v-if="draggingId" class="ux-dock__overlay" data-ux-part="drop-overlay">
      <div
        class="ux-dock__dz ux-dock__dz--left"
        :class="{ 'is-over': hoverZone === 'left' }"
        @dragover.prevent.stop="hoverZone = 'left'"
        @drop.prevent.stop="dropOn('left')"
      >
        {{ tr('shell.drop.left', '停靠到左侧') }}
      </div>
      <div
        class="ux-dock__dz ux-dock__dz--right"
        :class="{ 'is-over': hoverZone === 'right' }"
        @dragover.prevent.stop="hoverZone = 'right'"
        @drop.prevent.stop="dropOn('right')"
      >
        {{ tr('shell.drop.right', '停靠到右侧') }}
      </div>
      <div
        class="ux-dock__dz ux-dock__dz--bottom"
        :class="{ 'is-over': hoverZone === 'bottom' }"
        @dragover.prevent.stop="hoverZone = 'bottom'"
        @drop.prevent.stop="dropOn('bottom')"
      >
        {{ tr('shell.drop.bottom', '停靠到底部') }}
      </div>
      <div
        class="ux-dock__dz ux-dock__dz--float"
        :class="{ 'is-over': hoverZone === 'float' }"
        @dragover.prevent.stop="hoverZone = 'float'"
        @drop.prevent.stop="dropOn('float')"
      >
        {{ tr('shell.drop.float', '拖到此处悬浮') }}
      </div>
    </div>

    <div class="ux-dock__floats" data-ux-part="floats">
      <UxFloatPanel
        v-for="id in floatCards"
        :key="id"
        :panel-id="id"
        :title="titleOf(id)"
        :geom="layout.geomOf(id) ?? { x: 0, y: 0, w: 480, h: 360 }"
        :z="layout.zOf(id)"
        @focus="layout.focusFloat"
        @move="(pid, x, y) => layout.setGeom(pid, { x, y })"
        @resize="(pid, patch) => layout.setGeom(pid, patch)"
        @dock="layout.dockBack"
        @minimize="layout.minimize"
        @close="layout.hide"
      >
        <slot name="panel" :id="id" />
      </UxFloatPanel>
    </div>

    <div v-if="minimizedCards.length" class="ux-dock__stack" data-ux-part="minimize-stack">
      <button
        v-for="id in minimizedCards"
        :key="id"
        class="ux-dock__stack-item"
        type="button"
        :title="titleOf(id)"
        @click="layout.restore(id)"
      >
        <UxIcon name="act-float" />
        <span>{{ titleOf(id) }}</span>
      </button>
    </div>
  </div>
</template>
