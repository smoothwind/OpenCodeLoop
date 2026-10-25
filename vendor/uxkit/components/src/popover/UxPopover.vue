<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useDismiss, useOverflowPosition, type Placement } from '@ux/composables'

defineOptions({ name: 'UxPopover' })

const props = withDefaults(
  defineProps<{
    placement?: Placement
    /** 锚点与浮层间距（px） */
    offset?: number
    /** 视口边缘安全边距（px） */
    margin?: number
    disabled?: boolean
    /** 触发方式：click=点击锚点开合 / manual=仅经 API 控制 */
    trigger?: 'click' | 'manual'
    /** 指针点击浮层外部关闭 */
    dismissOnOutside?: boolean
    /** Esc 关闭 */
    dismissOnEscape?: boolean
    /** 浮层角色（含交互内容建议传 'dialog'） */
    role?: string
    /** 无障碍名称（角色为 dialog/menu 时建议提供） */
    ariaLabel?: string
    /** 浮层宽度与锚点对齐 */
    matchTriggerWidth?: boolean
    /** 打开后聚焦浮层（role=dialog 时配合使用） */
    focusOnOpen?: boolean
  }>(),
  {
    placement: 'bottom-start',
    offset: 4,
    margin: 8,
    trigger: 'click',
    dismissOnOutside: true,
    dismissOnEscape: true,
    matchTriggerWidth: false,
    focusOnOpen: false,
  },
)

/** 开合状态：绑定 v-model:open 即可受控；不绑定时为内部自持 */
const isOpen = defineModel<boolean>('open', { default: false })

const anchorEl = ref<HTMLElement | null>(null)
const popEl = ref<HTMLElement | null>(null)

const updatePosition = useOverflowPosition({
  anchor: anchorEl,
  popper: popEl,
  placement: props.placement,
  offset: props.offset,
  margin: props.margin,
  active: () => isOpen.value,
})

function setOpen(value: boolean): void {
  if (value && props.disabled) return
  isOpen.value = value
}

function close(): void {
  setOpen(false)
}

function toggle(): void {
  setOpen(!isOpen.value)
}

useDismiss({
  active: () => isOpen.value,
  escape: props.dismissOnEscape,
  onDismiss: (reason) => {
    if (reason === 'outside' && !props.dismissOnOutside) return
    setOpen(false)
  },
  ignore: () => [anchorEl.value, popEl.value],
})

function syncGeometry(): void {
  const p = popEl.value
  if (!p) return
  if (props.matchTriggerWidth) {
    const w = anchorEl.value?.offsetWidth ?? 0
    p.style.width = w ? `${w}px` : ''
    p.style.minWidth = w ? `${w}px` : ''
  } else {
    p.style.width = ''
    p.style.minWidth = ''
  }
  updatePosition()
}

watch(isOpen, (value) => {
  if (!value) return
  void nextTick(() => {
    syncGeometry()
    if (props.focusOnOpen) popEl.value?.focus()
  })
})

defineExpose({ open: () => setOpen(true), close, toggle })
</script>

<template>
  <span
    ref="anchorEl"
    class="ux-pop-trigger"
    :class="{ 'is-open': isOpen }"
    @click="trigger === 'click' && toggle()"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="isOpen"
      ref="popEl"
      class="ux-pop"
      tabindex="-1"
      :role="role"
      :aria-label="ariaLabel"
    >
      <slot name="content" />
    </div>
  </Teleport>
</template>
