<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useDismiss, useOverflowPosition } from '@ux/composables'
import UxIcon from '../icon/UxIcon.vue'
import MenuPanel from './MenuPanel.vue'
import { isCheckable, type MenuBarItem, type MenuItem } from './types'

const props = defineProps<{
  items: MenuBarItem[]
  /** 无障碍名称（红线 10） */
  ariaLabel?: string
}>()

const emit = defineEmits<{ select: [item: MenuItem] }>()

const focusIndex = ref(0)
const openIndex = ref(-1)
const btnEls = ref<HTMLElement[]>([])
const anchorEl = ref<HTMLElement | null>(null)
const dropdownEl = ref<HTMLElement | null>(null)

const updatePosition = useOverflowPosition({
  anchor: anchorEl,
  popper: dropdownEl,
  placement: 'bottom-start',
  offset: 2,
  active: () => openIndex.value >= 0,
})

useDismiss({
  active: () => openIndex.value >= 0,
  escape: false,
  onDismiss: (reason) => {
    const i = openIndex.value
    openIndex.value = -1
    if (reason === 'escape' && i >= 0) btnEls.value[i]?.focus()
  },
  ignore: () => [anchorEl.value, dropdownEl.value],
})

function openMenu(i: number): void {
  if (!props.items[i]?.items || props.items[i].disabled) return
  focusIndex.value = i
  openIndex.value = i
  anchorEl.value = btnEls.value[i] ?? null
  void nextTick(() => updatePosition())
}

function closeMenu(): void {
  openIndex.value = -1
}

function onBtnClick(i: number): void {
  const item = props.items[i]
  if (!item || item.disabled) return
  if (!item.items) {
    item.run?.()
    return
  }
  if (openIndex.value === i) closeMenu()
  else openMenu(i)
}

function onBtnEnter(i: number): void {
  // 已有菜单打开时，hover 跟随切换（APG）
  if (openIndex.value >= 0 && openIndex.value !== i) openMenu(i)
}

function move(delta: number): void {
  const total = props.items.length
  if (!total) return
  const base = openIndex.value >= 0 ? openIndex.value : focusIndex.value
  const next = (base + delta + total) % total
  focusIndex.value = next
  if (openIndex.value >= 0) {
    // 已展开：切到相邻顶级菜单，由下拉面板（key=openIndex）重挂载并聚焦首项
    openMenu(next)
  } else {
    btnEls.value[next]?.focus()
  }
}

function onBarKeydown(e: KeyboardEvent): void {
  // 忽略来自下拉菜单内部的按键（否则 ←→/↓ 会被双击处理）
  if ((e.target as HTMLElement | null)?.closest?.('.ux-menu')) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Home') {
    e.preventDefault()
    focusIndex.value = 0
    btnEls.value[0]?.focus()
  } else if (e.key === 'End') {
    e.preventDefault()
    const last = props.items.length - 1
    focusIndex.value = last
    btnEls.value[last]?.focus()
  } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    openMenu(focusIndex.value)
  }
}

function onMenuReady(el: HTMLElement): void {
  dropdownEl.value = el
  updatePosition()
}

function onMenuSelect(item: MenuItem): void {
  if (!isCheckable(item)) closeMenu()
  emit('select', item)
}

function onMenuNavigate(dir: 'left' | 'right'): void {
  move(dir === 'right' ? 1 : -1)
}
</script>

<template>
  <div class="ux-menubar" role="menubar" :aria-label="ariaLabel" @keydown="onBarKeydown">
    <button
      v-for="(item, i) in items"
      :key="item.id ?? i"
      :ref="(el) => { if (el) btnEls[i] = el as HTMLElement }"
      class="ux-menubar__btn"
      :class="{ 'is-active': openIndex === i }"
      type="button"
      role="menuitem"
      :tabindex="i === focusIndex ? 0 : -1"
      :aria-haspopup="item.items ? 'menu' : undefined"
      :aria-expanded="item.items ? openIndex === i : undefined"
      :aria-disabled="item.disabled ? 'true' : undefined"
      :disabled="item.disabled"
      @click="onBtnClick(i)"
      @mouseenter="onBtnEnter(i)"
      @focus="focusIndex = i"
    >
      <UxIcon v-if="item.icon" :name="item.icon" />
      <span>{{ item.label }}</span>
    </button>

    <MenuPanel
      v-if="openIndex >= 0 && items[openIndex]?.items"
      :key="openIndex"
      class="ux-menubar__menu"
      :items="items[openIndex]!.items!"
      @select="onMenuSelect"
      @dismiss="closeMenu"
      @navigate="onMenuNavigate"
      @ready="onMenuReady"
    />
  </div>
</template>
