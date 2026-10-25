import type { IconId } from '../icon/registry'

/** 菜单项类型（缺省 'item'）——规范见 docs/UxKit-设计方案.md §6.6 */
export type MenuItemKind = 'item' | 'separator' | 'label' | 'checkbox' | 'radio' | 'submenu'

export interface MenuItem {
  /** 项类型；'separator' 也可用 `separator: true` 简写 */
  type?: MenuItemKind
  id?: string
  label?: string
  icon?: IconId
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** 兼容旧写法，等价 `type: 'separator'` */
  separator?: boolean
  /** checkbox / radio 的选中态（由调用方维护，经 computed 回灌） */
  checked?: boolean
  /** radio 分组名（同组互斥由调用方维护） */
  group?: string
  /** submenu 子项（最多 2 级） */
  items?: MenuItem[]
  run?: () => void
}

/** 工具菜单栏的顶层项：有 items 为下拉菜单，否则为直接命令 */
export interface MenuBarItem {
  id?: string
  label: string
  icon?: IconId
  disabled?: boolean
  items?: MenuItem[]
  run?: () => void
}

export function menuItemKind(item: MenuItem): MenuItemKind {
  if (item.type) return item.type
  if (item.separator) return 'separator'
  if (item.items) return 'submenu'
  return 'item'
}

export function isCheckable(item: MenuItem): boolean {
  const k = menuItemKind(item)
  return k === 'checkbox' || k === 'radio'
}
