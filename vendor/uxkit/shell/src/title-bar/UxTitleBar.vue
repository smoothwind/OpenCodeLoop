<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { UxIcon } from '@ux/components'
import { getPlatformAdapter, tryUseI18n, type WindowControls } from '@ux/services'

defineProps<{ title?: string }>()

const i18n = tryUseI18n()
function tr(key: string, fallback: string): string {
  if (!i18n) return fallback
  const value = i18n.t(key)
  return value === key ? fallback : value
}

const controls = ref<WindowControls | null>(null)
const maximized = ref(false)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  const windowControls = getPlatformAdapter()?.windowControls
  if (!windowControls) return
  controls.value = windowControls
  void windowControls.isMaximized().then((value) => {
    maximized.value = value
  })
  unsubscribe = windowControls.onMaximizedChange((value) => {
    maximized.value = value
  })
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <header class="ux-titlebar" data-ux="titlebar">
    <div class="ux-titlebar__left" data-ux-part="titlebar-left"><slot name="left" /></div>
    <div class="ux-titlebar__center" data-ux-part="titlebar-center">
      <span v-if="title" class="ux-titlebar__title">{{ title }}</span>
      <slot />
    </div>
    <div class="ux-titlebar__right" data-ux-part="titlebar-right">
      <slot name="right" />
      <div v-if="controls" class="ux-titlebar__controls" data-ux-part="window-controls">
        <button
          class="ux-titlebar__ctl"
          type="button"
          :aria-label="tr('shell.window.minimize', '最小化')"
          :title="tr('shell.window.minimize', '最小化')"
          @click="controls.minimize()"
        >
          <UxIcon name="act-window-minimize" />
        </button>
        <button
          class="ux-titlebar__ctl"
          type="button"
          :aria-label="maximized ? tr('shell.window.restore', '还原') : tr('shell.window.maximize', '最大化')"
          :title="maximized ? tr('shell.window.restore', '还原') : tr('shell.window.maximize', '最大化')"
          @click="controls.toggleMaximize()"
        >
          <UxIcon :name="maximized ? 'act-window-restore' : 'act-window-maximize'" />
        </button>
        <button
          class="ux-titlebar__ctl ux-titlebar__ctl--close"
          type="button"
          :aria-label="tr('shell.window.close', '关闭')"
          :title="tr('shell.window.close', '关闭')"
          @click="controls.close()"
        >
          <UxIcon name="act-close" />
        </button>
      </div>
    </div>
  </header>
</template>
