import type { IconId } from '@ux/components'

/** SettingsShell 分类项 */
export interface SettingsCategory {
  id: string
  label: string
  icon?: IconId
}

/** TourGuide 步骤：target 为 CSS 选择器，缺省 = 无锚点（整屏暗化居中卡片） */
export interface TourStep {
  target?: string
  title: string
  desc: string
}

/** UxDataTable 列定义 */
export interface DataTableColumn {
  name: string
  width?: number
  align?: 'left' | 'right' | 'center'
}
