<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@ux/composables'
import UxIcon from '../icon/UxIcon.vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title?: string
    closeOnScrim?: boolean
    showClose?: boolean
  }>(),
  { closeOnScrim: true, showClose: true },
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const dialogEl = ref<HTMLElement | null>(null)

function close(): void {
  emit('update:open', false)
}

useFocusTrap(dialogEl, { active: () => props.open, onEscape: close })
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ux-dialog__scrim" @mousedown.self="closeOnScrim && close()">
      <div
        ref="dialogEl"
        class="ux-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        tabindex="-1"
      >
        <header v-if="title || showClose" class="ux-dialog__header">
          <h2 class="ux-dialog__title">{{ title }}</h2>
          <button
            v-if="showClose"
            class="ux-btn ux-btn--ghost ux-btn--sm ux-btn--icon-only"
            type="button"
            aria-label="关闭"
            @click="close"
          >
            <UxIcon name="act-close" />
          </button>
        </header>
        <div class="ux-dialog__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="ux-dialog__footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
