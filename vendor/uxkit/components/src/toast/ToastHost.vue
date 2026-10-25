<script setup lang="ts">
import UxIcon from '../icon/UxIcon.vue'
import type { IconId } from '../icon/registry'
import { dismissToast, toastState, type ToastType } from './service'

const ICONS: Record<ToastType, IconId> = {
  info: 'st-info',
  success: 'st-success',
  warning: 'st-warning',
  danger: 'st-error',
}
</script>

<template>
  <Teleport to="body">
    <div class="ux-toast-host" aria-live="polite">
      <div
        v-for="t in toastState.toasts.value"
        :key="t.id"
        class="ux-toast"
        :class="`ux-toast--${t.type}`"
        role="status"
      >
        <UxIcon class="ux-toast__icon" :name="ICONS[t.type]" />
        <div class="ux-toast__body">
          <span>{{ t.message }}</span>
          <button
            v-if="t.action"
            class="ux-toast__action"
            type="button"
            @click="t.action.run(), dismissToast(t.id)"
          >
            {{ t.action.label }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
