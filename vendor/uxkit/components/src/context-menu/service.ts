import { ref, shallowRef } from 'vue'
import type { MenuItem } from '../menu/types'

export type { MenuItem, MenuItemKind, MenuBarItem } from '../menu/types'
export { menuItemKind, isCheckable } from '../menu/types'

/** 菜单项来源：静态数组，或 getter（复选/单选随状态实时刷新） */
export type MenuItemsSource = MenuItem[] | (() => MenuItem[])

/**
 * 模块级单例菜单状态。ContextMenuHost 负责渲染，
 * 任意组件可直接调用 openContextMenu，无需层级依赖。
 */
export const menuState = {
  open: ref(false),
  x: ref(0),
  y: ref(0),
  items: shallowRef<MenuItemsSource>([]),
}

/** 在鼠标事件位置打开右键菜单 */
export function openContextMenu(event: MouseEvent, items: MenuItemsSource): void {
  openContextMenuAt(event.clientX, event.clientY, items)
}

/** 在指定坐标打开右键菜单（虚拟滚动/画布等只有坐标的场景） */
export function openContextMenuAt(x: number, y: number, items: MenuItemsSource): void {
  menuState.x.value = x
  menuState.y.value = y
  menuState.items.value = items
  menuState.open.value = true
}

export function closeContextMenu(): void {
  menuState.open.value = false
}
