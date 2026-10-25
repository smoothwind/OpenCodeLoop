<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useDismiss, useOverflowPosition, type Placement } from '@ux/composables'
import UxIcon from '../icon/UxIcon.vue'
import UxMenuPanel from '../menu/MenuPanel.vue'
import { isCheckable, type MenuItem } from '../menu/types'
import type { IconId } from '../icon/registry'

defineOptions({ name: 'UxDropdown' })

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    /** 触发按钮文案；仅图标时请用 ariaLabel（红线 14） */
    label?: string
    icon?: IconId
    /** 无障碍名称（触发按钮的 aria-label / 菜单的 aria-label） */
    ariaLabel?: string
    placement?: Placement
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    /** 是否显示右侧 chevron */
    showCaret?: boolean
    /** 菜单宽度与触发按钮对齐 */
    matchTriggerWidth?: boolean
  }>(),
  {
    placement: 'bottom-start',
    variant: 'secondary',
    size: 'md',
    showCaret: true,
    matchTriggerWidth: false,
  },
)

const emit = defineEmits<{ select: [item: MenuItem] }>()

/** 开合状态：绑定 v-model:open 即可受控；不绑定时为内部自持 */
const isOpen = defineModel<boolean>('open', { default: false })

const anchorEl = ref<HTMLElement | null>(null)
const btnEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)

const updatePosition = useOverflowPosition({
  anchor: anchorEl,
  popper: menuEl,
  placement: props.placement,
  offset: 2,
  active: () => isOpen.value,
})

function setOpen(value: boolean): void {
  if (value && props.disabled) return
  isOpen.value = value
}

function close(): void {
  setOpen(false)
}

/** APG menubutton：Esc / 方向键关闭后焦点归还触发按钮 */
function closeAndReturn(): void {
  close()
  btnEl.value?.focus()
}

function toggleOpen(): void {
  if (isOpen.value) closeAndReturn()
  else setOpen(true)
}

function syncGeometry(): void {
  const m = menuEl.value
  if (!m) return
  if (props.matchTriggerWidth) {
    const w = btnEl.value?.offsetWidth ?? 0
    m.style.minWidth = w ? `${w}px` : ''
  }
  updatePosition()
}

watch(isOpen, (value) => {
  if (value) {
    void nextTick(() => syncGeometry())
    document.addEventListener('keydown', onDocKeydown, true)
  } else {
    document.removeEventListener('keydown', onDocKeydown, true)
  }
})

/** APG：菜单内 Tab 只进出一次，离开即关闭 */
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Tab') close()
}

onBeforeUnmount(() => document.removeEventListener('keydown', onDocKeydown, true))

// Esc 交给 MenuPanel 分层处理（先关子菜单再关整层），故此处 escape: false
useDismiss({
  active: () => isOpen.value,
  escape: false,
  onDismiss: close,
  ignore: () => [anchorEl.value, menuEl.value],
})

function onMenuReady(el: HTMLElement): void {
  menuEl.value = el
  syncGeometry()
}

function onSelect(item: MenuItem): void {
  emit('select', item)
  if (!isCheckable(item)) closeAndReturn()
}

defineExpose({ open: () => setOpen(true), close, toggle: toggleOpen })
</script>

<template>
  <span ref="anchorEl" class="ux-dropdown">
    <button
      ref="btnEl"
      class="ux-btn ux-dropdown__btn"
      :class="[`ux-btn--${variant}`, `ux-btn--${size}`]"
      type="button"
      :aria-label="ariaLabel"
      aria-haspopup="menu"
      :aria-expanded="isOpen"
      :disabled="disabled"
      @click="toggleOpen"
      @keydown.down.prevent="setOpen(true)"
      @keydown.up.prevent="setOpen(true)"
      @keydown.enter.prevent="setOpen(true)"
      @keydown.space.prevent="setOpen(true)"
      @keydown.esc="isOpen && closeAndReturn()"
    >
      <UxIcon v-if="icon" :name="icon" />
      <span v-if="label" class="ux-btn__text">{{ label }}</span>
      <UxIcon v-if="showCaret" name="act-chevron-down" class="ux-dropdown__caret" />
    </button>

    <Teleport to="body">
      <UxMenuPanel
        v-if="isOpen"
        class="ux-dropdown__menu"
        :items="items"
        :aria-label="ariaLabel ?? label"
        @select="onSelect"
        @dismiss="closeAndReturn"
        @ready="onMenuReady"
      />
    </Teleport>
  </span>
</template>
