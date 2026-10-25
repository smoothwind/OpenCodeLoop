import { shallowRef, type Ref } from 'vue'
import { getAllCommands, runCommand, type Command } from './command'

const MODIFIER_ORDER = ['Ctrl', 'Shift', 'Alt', 'Meta'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  meta: 'Meta',
  cmd: 'Meta',
  win: 'Meta',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  comma: ',',
  period: '.',
  slash: '/',
}

/** 浏览器/系统保留键位——使用它们会劫持宿主行为，注册时应避开或显式确认 */
export const RESERVED_SHORTCUTS = [
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+A',
  'Ctrl+Z',
  'Ctrl+Y',
  'Ctrl+F',
  'Ctrl+P',
  'Ctrl+W',
  'Ctrl+T',
  'Ctrl+N',
  'F5',
  'F11',
  'F12',
]

function normalizeKey(raw: string): string {
  const lower = raw.toLowerCase()
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower]
  if (raw.length === 1) return raw.toUpperCase()
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** 'ctrl+shift+t' → 'Ctrl+Shift+T'（modifier 固定顺序，key 大写） */
export function normalizeShortcut(input: string): string {
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean)
  const mods = new Set<Modifier>()
  let key = ''
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()]
    if (alias) mods.add(alias)
    else key = normalizeKey(part)
  }
  const modStr = MODIFIER_ORDER.filter((m) => mods.has(m)).join('+')
  return modStr ? `${modStr}+${key}` : key
}

/** 从键盘事件还原规范键序；仅按到修饰键本身时返回 null */
export function eventToShortcut(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.shiftKey) mods.push('Shift')
  if (e.altKey) mods.push('Alt')
  if (e.metaKey) mods.push('Meta')
  const key = e.key
  // KeyboardEvent.key 对修饰键的本名为 Control/Shift/Alt/Meta（注意 Control ≠ Ctrl）
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null
  const normalizedKey = normalizeKey(key === ' ' ? 'space' : key)
  return [...mods, normalizedKey].join('+')
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export interface ShortcutIssue {
  type: 'duplicate' | 'reserved'
  combo: string
  ids: string[]
  message: string
}

/** 冲突检测：同一键序绑定多个命令（duplicate）+ 命中保留键位（reserved）。
 *  resolve 用于取"有效键序"（含用户改键覆盖），默认取命令声明值。 */
export function findShortcutIssues(
  commands: Command[] = getAllCommands(),
  resolve: (cmd: Command) => string | undefined = (cmd) => cmd.shortcut,
): ShortcutIssue[] {
  const issues: ShortcutIssue[] = []
  const byCombo = new Map<string, string[]>()
  for (const cmd of commands) {
    const raw = resolve(cmd)
    if (!raw) continue
    const combo = normalizeShortcut(raw)
    byCombo.set(combo, [...(byCombo.get(combo) ?? []), cmd.id])
    if (RESERVED_SHORTCUTS.includes(combo)) {
      issues.push({
        type: 'reserved',
        combo,
        ids: [cmd.id],
        message: `命令 ${cmd.id} 使用了保留键位 ${combo}`,
      })
    }
  }
  for (const [combo, ids] of byCombo) {
    if (ids.length > 1) {
      issues.push({
        type: 'duplicate',
        combo,
        ids,
        message: `键位 ${combo} 被多个命令占用：${ids.join(' / ')}`,
      })
    }
  }
  return issues
}

export interface ShortcutController {
  /** 安装全局监听（幂等），返回卸载函数 */
  install(): () => void
  /** 用户键位覆盖：null 表示恢复默认 */
  setOverride(commandId: string, keys: string | null): void
  getOverride(commandId: string): string | undefined
  getEffectiveShortcut(commandId: string): string | undefined
  getIssues(): ShortcutIssue[]
  /** 暂停/恢复全局匹配（自定义键位录制时使用） */
  setSuspended(value: boolean): void
  /** 用户改键覆盖的响应式快照（供 UI 依赖追踪） */
  readonly overrides: Ref<Record<string, string>>
}

/**
 * 快捷键控制器：单例安装后监听 keydown，
 * 有效键序 = 用户覆盖 ?? 命令默认；输入框聚焦时只放行 allowInInput 命令。
 */
export function createShortcutController(): ShortcutController {
  const overrides = shallowRef<Record<string, string>>({})
  let installed = false
  let suspended = false
  let dispose: (() => void) | null = null

  function effective(cmd: Command): string | undefined {
    return overrides.value[cmd.id] ?? cmd.shortcut
  }

  function onKeydown(e: KeyboardEvent): void {
    if (suspended) {
      return
    }
    const combo = eventToShortcut(e)
    if (!combo) {
      return
    }
    const inEditable = isEditable(e.target)
    const commands = getAllCommands()

    for (const cmd of commands) {
      if (!cmd.allowInInput) continue
      const shortcut = effective(cmd)
      if (shortcut && normalizeShortcut(shortcut) === combo) {
        e.preventDefault()
        void runCommand(cmd.id)
        return
      }
    }

    const issues = findShortcutIssues(commands, effective)
    const conflicted = new Set<string>()
    for (const issue of issues) {
      if (issue.type === 'duplicate') for (const id of issue.ids) conflicted.add(id)
    }

    for (const cmd of commands) {
      if (conflicted.has(cmd.id)) continue
      const shortcut = effective(cmd)
      if (!shortcut || normalizeShortcut(shortcut) !== combo) continue
      if (inEditable && !cmd.allowInInput) return
      e.preventDefault()
      void runCommand(cmd.id)
      return
    }
  }

  return {
    install() {
      if (installed) return dispose ?? (() => {})
      installed = true
      document.addEventListener('keydown', onKeydown, true)
      const issues = findShortcutIssues()
      if (issues.length > 0) {
        console.warn('[UxKit 快捷键] 检测到冲突：', issues.map((i) => i.message).join('；'))
      }
      dispose = () => {
        document.removeEventListener('keydown', onKeydown, true)
        installed = false
      }
      return dispose
    },
    setOverride(commandId: string, keys: string | null) {
      const next = { ...overrides.value }
      if (keys === null) delete next[commandId]
      else next[commandId] = normalizeShortcut(keys)
      overrides.value = next
    },
    getOverride(commandId: string) {
      return overrides.value[commandId]
    },
    getEffectiveShortcut(commandId: string) {
      const cmd = getAllCommands().find((c) => c.id === commandId)
      return cmd ? effective(cmd) : undefined
    },
    getIssues() {
      return findShortcutIssues(getAllCommands(), effective)
    },
    setSuspended(value: boolean) {
      suspended = value
    },
    overrides,
  }
}

export const shortcuts = createShortcutController()
