<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { UxIcon, UxKbd } from '@ux/components'
import { useFocusTrap } from '@ux/composables'
import {
  commandVersion,
  getAllCommands,
  registerCommand,
  runCommand,
  tryUseI18n,
  type Command,
} from '@ux/services'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    hotkey?: string
    /** 语言包中面板标题的 key */
    titleKey?: string
  }>(),
  {
    placeholder: '输入命令…',
    hotkey: 'Ctrl+K',
    titleKey: 'commands.palette.title',
  },
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const HOTKEY_COMMAND_ID = 'palette.open'

const i18n = tryUseI18n()
const isOpen = ref(false)

function setOpen(next: boolean): void {
  isOpen.value = next
  emit('update:open', next)
}
function close(): void {
  setOpen(false)
}

function tr(key: string, fallback: string): string {
  return i18n ? i18n.t(key) : fallback
}

const panelEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const activeIndex = ref(0)

const commands = computed<Command[]>(() => {
  void commandVersion()
  return getAllCommands().filter(
    (c) => c.id !== HOTKEY_COMMAND_ID && (!c.when || c.when()),
  )
})

function labelOf(cmd: Command): string {
  return i18n ? i18n.t(cmd.title) : cmd.title
}

const filtered = computed<Command[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return commands.value
  return commands.value.filter(
    (c) =>
      labelOf(c).toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q) ||
      (c.category ?? '').toLowerCase().includes(q),
  )
})

function move(delta: number): void {
  const total = filtered.value.length
  if (total === 0) return
  activeIndex.value = (activeIndex.value + delta + total) % total
  void nextTick(() => {
    panelEl.value
      ?.querySelector('.ux-cmdk__item.is-active')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function run(cmd: Command | undefined): void {
  if (!cmd) return
  const id = cmd.id
  close()
  void runCommand(id)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(filtered.value[activeIndex.value])
  }
}

useFocusTrap(panelEl, { active: isOpen, onEscape: close })

watch(query, () => {
  activeIndex.value = 0
})

watch(isOpen, (open) => {
  if (open) {
    query.value = ''
    activeIndex.value = 0
    void nextTick(() => inputEl.value?.focus())
  }
})

const disposeHotkey = registerCommand({
  id: HOTKEY_COMMAND_ID,
  title: props.titleKey,
  shortcut: props.hotkey,
  allowInInput: true,
  run: () => setOpen(true),
})
onUnmounted(disposeHotkey)

defineExpose({ open: () => setOpen(true), close })
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="ux-cmdk__scrim" @mousedown.self="close">
      <div
        ref="panelEl"
        class="ux-cmdk"
        role="dialog"
        aria-modal="true"
        :aria-label="tr(titleKey, '命令面板')"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <div class="ux-cmdk__search">
          <UxIcon name="act-search" />
          <input
            ref="inputEl"
            v-model="query"
            class="ux-cmdk__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="ux-cmdk-list"
            aria-autocomplete="list"
            :aria-activedescendant="
              filtered.length ? `ux-cmdk-opt-${activeIndex}` : undefined
            "
            :placeholder="placeholder"
          />
        </div>

        <ul id="ux-cmdk-list" class="ux-cmdk__list" role="listbox" aria-label="命令列表">
          <li v-if="filtered.length === 0" class="ux-cmdk__empty">
            {{ tr('commands.palette.empty', '无匹配命令') }}
          </li>
          <li
            v-for="(c, i) in filtered"
            :id="`ux-cmdk-opt-${i}`"
            :key="c.id"
            class="ux-cmdk__item"
            :class="{
              'is-active': i === activeIndex,
              'ux-cmdk__item--danger': c.danger,
            }"
            role="option"
            :aria-selected="i === activeIndex"
            @mousemove="activeIndex = i"
            @click="run(c)"
          >
            <UxIcon v-if="c.icon" :name="c.icon" />
            <span class="ux-cmdk__item-label">{{ labelOf(c) }}</span>
            <span v-if="c.category" class="ux-cmdk__item-cat">{{ c.category }}</span>
            <UxKbd v-if="c.shortcut" :keys="c.shortcut" />
          </li>
        </ul>

        <footer class="ux-cmdk__footer">
          <span><UxKbd keys="↑" /> <UxKbd keys="↓" /> {{ tr('commands.palette.hintMove', '选择') }}</span>
          <span><UxKbd keys="Enter" /> {{ tr('commands.palette.hintRun', '执行') }}</span>
          <span><UxKbd keys="Esc" /> {{ tr('commands.palette.hintClose', '关闭') }}</span>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
