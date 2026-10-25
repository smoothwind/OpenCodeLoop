<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useDismiss, useOverflowPosition } from '@ux/composables'
import MenuPanel from '../menu/MenuPanel.vue'
import { isCheckable, type MenuItem } from '../menu/types'
import { closeContextMenu, menuState } from './service'

const menuEl = ref<HTMLElement | null>(null)
const lastFocused = ref<HTMLElement | null>(null)

const items = computed<MenuItem[]>(() => {
  const src = menuState.items.value
  return typeof src === 'function' ? src() : src
})

const updatePosition = useOverflowPosition({
  anchor: menuEl,
  popper: menuEl,
  placement: 'bottom-start',
  active: () => menuState.open.value,
  getRect: () => {
    const x = menuState.x.value
    const y = menuState.y.value
    return { left: x, top: y, right: x, bottom: y }
  },
})

function onReady(el: HTMLElement): void {
  menuEl.value = el
  updatePosition()
}

function onSelect(item: MenuItem): void {
  // checkbox / radio 切换后保持菜单打开（APG）
  if (!isCheckable(item)) closeContextMenu()
}

useDismiss({
  active: () => menuState.open.value,
  escape: false,
  onDismiss: closeContextMenu,
  ignore: () => [menuEl.value],
})

watch(
  () => menuState.open.value,
  (open) => {
    if (open) {
      lastFocused.value = document.activeElement as HTMLElement | null
      void nextTick(() => updatePosition())
    } else {
      lastFocused.value?.focus?.()
      lastFocused.value = null
    }
  },
)

/**
 * 键盘右键：Shift+F10 / 菜单键。
 * 标准环境下宿主（Chromium / Electron / Tauri webview）会原生派发 contextmenu，
 * 此处仅作兜底：下一拍若未见原生事件，则在聚焦元素上合成 contextmenu，
 * 复用各处既有的「单入口」处理器，避免重复绑定。
 */
let nativeContextSeen = false

function onNativeContext(): void {
  nativeContextSeen = true
}

function onKeyboardContext(e: KeyboardEvent): void {
  const isContextKey = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
  if (!isContextKey || menuState.open.value) return
  nativeContextSeen = false
  window.setTimeout(() => {
    if (nativeContextSeen || menuState.open.value) return
    const el = document.activeElement as HTMLElement | null
    if (!el || el === document.body) return
    const rect = el.getBoundingClientRect()
    el.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.min(rect.width / 2, 24),
        clientY: rect.bottom,
      }),
    )
  }, 0)
}

onMounted(() => {
  document.addEventListener('contextmenu', onNativeContext, true)
  window.addEventListener('keydown', onKeyboardContext)
})
onBeforeUnmount(() => {
  document.removeEventListener('contextmenu', onNativeContext, true)
  window.removeEventListener('keydown', onKeyboardContext)
})
</script>

<template>
  <Teleport to="body">
    <MenuPanel
      v-if="menuState.open.value"
      :items="items"
      @select="onSelect"
      @dismiss="closeContextMenu"
      @ready="onReady"
    />
  </Teleport>
</template>
