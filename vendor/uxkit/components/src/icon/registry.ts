import data from './registry.json'

export type IconCategory = 'obj' | 'act' | 'st'

export interface IconEntry {
  category: IconCategory
  /** 唯一语义描述——iconId ↔ 语义一对一（红线 13，check-icons 校验） */
  semantic: string
  paths: string[]
}

export const iconRegistry = data as Record<string, IconEntry>

export type IconId = keyof typeof data

export const iconIds = Object.keys(iconRegistry) as IconId[]

export function getIcon(id: IconId): IconEntry {
  const entry = iconRegistry[id]
  if (!entry) throw new Error(`[UxIcon] 未注册的图标 id: ${id}`)
  return entry
}
