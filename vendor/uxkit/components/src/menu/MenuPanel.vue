<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useHoverIntent } from '@ux/composables'
import UxIcon from '../icon/UxIcon.vue'
import { isCheckable, menuItemKind, type MenuItem, type MenuItemKind } from './types'

defineOptions({ name: 'UxMenuPanel' })

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    /** 无障碍名称（红线 10） */
    ariaLabel?: string
    /** 子菜单：绝对定位在父项右侧 */
    submenu?: boolean
  }>(),
  { submenu: false },
)

const emit = defineEmits<{
  select: [item: MenuItem]
  dismiss: []
  navigate: [dir: 'left' | 'right']
  ready: [el: HTMLElement]
}>()

const rootEl = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)
const openSubIndex = ref(-1)
const flip = ref(false)

/** hover 意图延迟走廊：已有子菜单打开时，跨越项切换需停留此时长才生效（APG） */
const { schedule: scheduleHover, cancel: cancelHover } = useHoverIntent(120)

function kind(it: MenuItem): MenuItemKind {
  return menuItemKind(it)
}

function isNavigable(i: number): boolean {
  const it = props.items[i]
  if (!it) return false
  const k = kind(it)
  return k !== 'separator' && k !== 'label'
}

function findNext(from: number, delta: number): number {
  const total = props.items.length
  if (!total) return -1
  let i = from
  for (let step = 0; step < total; step++) {
    i = (i + delta + total) % total
    if (isNavigable(i)) return i
  }
  return -1
}

/** 初始聚焦：首个非禁用项（APG menubar 约定） */
function firstEnabled(): number {
  for (let i = 0; i < props.items.length; i++) {
    const it = props.items[i]
    if (it && isNavigable(i) && !it.disabled) return i
  }
  return findNext(-1, 1)
}

function activate(i: number): void {
  const it = props.items[i]
  if (!it || it.disabled) return
  if (kind(it) === 'submenu') {
    openSubIndex.value = i
    return
  }
  it.run?.()
  emit('select', it)
}

function openSub(i: number): void {
  cancelHover()
  const it = props.items[i]
  if (it && !it.disabled && kind(it) === 'submenu') openSubIndex.value = i
}

function closeSub(): void {
  cancelHover()
  openSubIndex.value = -1
  rootEl.value?.focus()
}

function onRowClick(i: number): void {
  cancelHover()
  const it = props.items[i]
  if (!it || it.disabled) return
  if (kind(it) === 'submenu') {
    openSub(i)
    return
  }
  activeIndex.value = i
  activate(i)
}

function onRowHover(i: number): void {
  activeIndex.value = i
  // 全部关闭时：仅高亮，须点击展开（APG，避免屏幕放大器误触）
  if (openSubIndex.value < 0 || openSubIndex.value === i) {
    cancelHover()
    return
  }
  // 已有子菜单打开：走 hover 意图延迟走廊，跨越项/移向同级时延迟切换或收起
  const it = props.items[i]
  const isSub = !!it && !it.disabled && kind(it) === 'submenu'
  scheduleHover(() => {
    if (isSub) openSubIndex.value = i
    else openSubIndex.value = -1
  })
}

function onKeydown(e: KeyboardEvent): void {
  // 只处理本层：避免子菜单的按键冒泡到父菜单（否则 Esc/← 会关掉整层）
  if (e.target !== e.currentTarget) return
  cancelHover()
  const k = e.key
  if (k === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = findNext(activeIndex.value, 1)
  } else if (k === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = findNext(activeIndex.value, -1)
  } else if (k === 'Home') {
    e.preventDefault()
    activeIndex.value = findNext(-1, 1)
  } else if (k === 'End') {
    e.preventDefault()
    activeIndex.value = findNext(props.items.length, -1)
  } else if (k === 'Enter' || k === ' ') {
    e.preventDefault()
    activate(activeIndex.value)
  } else if (k === 'ArrowRight') {
    e.preventDefault()
    const it = props.items[activeIndex.value]
    if (it && kind(it) === 'submenu') openSub(activeIndex.value)
    else emit('navigate', 'right')
  } else if (k === 'ArrowLeft') {
    if (props.submenu) {
      e.preventDefault()
      emit('dismiss')
    } else {
      emit('navigate', 'left')
    }
  } else if (k === 'Escape') {
    e.preventDefault()
    if (openSubIndex.value >= 0) closeSub()
    else emit('dismiss')
  } else if (k.length === 1 && /\S/.test(k)) {
    const ch = k.toLowerCase()
    const found = props.items.findIndex(
      (it, i) => isNavigable(i) && (it.label ?? '').toLowerCase().startsWith(ch),
    )
    if (found >= 0) activeIndex.value = found
  }
}

onMounted(() => {
  activeIndex.value = firstEnabled()
  void nextTick(() => {
    const el = rootEl.value
    if (!el) return
    emit('ready', el)
    el.focus()
    if (props.submenu && el.getBoundingClientRect().right > window.innerWidth - 8) flip.value = true
  })
})

defineExpose({ getEl: () => rootEl.value })
</script>

<template>
  <div
    ref="rootEl"
    class="ux-menu"
    :class="{ 'ux-menu--sub': submenu, 'is-flip': flip }"
    role="menu"
    tabindex="-1"
    :aria-label="ariaLabel"
    @keydown="onKeydown"
  >
    <template v-for="(it, i) in items" :key="it.id ?? i">
      <div v-if="kind(it) === 'separator'" class="ux-menu__sep" role="separator" />
      <div v-else-if="kind(it) === 'label'" class="ux-menu__label">{{ it.label }}</div>
      <div v-else class="ux-menu__row" role="none" @mouseenter="onRowHover(i)">
        <button
          class="ux-menu__item"
          :class="{ 'ux-menu__item--danger': it.danger, 'is-active': i === activeIndex }"
          type="button"
          :role="kind(it) === 'checkbox' ? 'menuitemcheckbox' : kind(it) === 'radio' ? 'menuitemradio' : 'menuitem'"
          :aria-checked="isCheckable(it) ? !!it.checked : undefined"
          :aria-haspopup="kind(it) === 'submenu' ? 'menu' : undefined"
          :aria-expanded="kind(it) === 'submenu' ? openSubIndex === i : undefined"
          :aria-disabled="it.disabled ? 'true' : undefined"
          :disabled="it.disabled"
          @mousemove="activeIndex = i"
          @click="onRowClick(i)"
        >
          <span class="ux-menu__lead">
            <UxIcon v-if="isCheckable(it) && it.checked" name="act-check" />
            <UxIcon v-else-if="it.icon && !isCheckable(it)" :name="it.icon" />
          </span>
          <span class="ux-menu__item-label">{{ it.label }}</span>
          <span v-if="it.shortcut" class="ux-menu__kbd">{{ it.shortcut }}</span>
          <UxIcon v-if="kind(it) === 'submenu'" name="act-chevron-right" class="ux-menu__caret" />
        </button>
        <UxMenuPanel
          v-if="openSubIndex === i && kind(it) === 'submenu'"
          submenu
          :items="it.items ?? []"
          @select="emit('select', $event)"
          @dismiss="closeSub"
          @navigate="emit('navigate', $event)"
        />
      </div>
    </template>
  </div>
</template>
