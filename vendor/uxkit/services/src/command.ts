import { shallowRef } from 'vue'
import type { IconId } from '@ux/components'

export interface Command {
  /** 全局唯一 id，如 'file.save' / 'conn.reconnect' */
  id: string
  /** 标题（i18n key 或字面量） */
  title: string
  icon?: IconId
  /** 规范键序，如 'Ctrl+K'（大小写/顺序任意，运行时归一化） */
  shortcut?: string
  /** 能力表达式：返回 false 时命令不可用（能力驱动显隐） */
  when?: () => boolean
  /** 命令面板分组 */
  category?: string
  /** 危险动作（右键菜单红色项） */
  danger?: boolean
  /** 输入框/编辑器聚焦时仍可触发（如全局面板快捷键） */
  allowInInput?: boolean
  run: () => void | Promise<void>
}

const registry = new Map<string, Command>()
const version = shallowRef(0)

function bump(): void {
  version.value++
}

/** 响应式版本号：命令列表变化的依赖追踪入口 */
export function commandVersion(): number {
  return version.value
}

/** 注册命令，返回注销函数（便于在 onScopeDispose 中使用） */
export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd)
  bump()
  return () => unregisterCommand(cmd.id)
}

export function unregisterCommand(id: string): void {
  if (registry.delete(id)) bump()
}

export function getCommand(id: string): Command | undefined {
  return registry.get(id)
}

export function getAllCommands(): Command[] {
  void version.value
  return [...registry.values()]
}

/** 过滤 when 表达式后可用命令 */
export function getAvailableCommands(): Command[] {
  return getAllCommands().filter((c) => !c.when || c.when())
}

export async function runCommand(id: string): Promise<boolean> {
  const cmd = registry.get(id)
  if (!cmd) return false
  if (cmd.when && !cmd.when()) return false
  await cmd.run()
  return true
}
