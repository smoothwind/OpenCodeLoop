import type { IconId } from '@ux/components'
import type { TabItemState } from '@ux/composables'

/** 活动栏条目（图标语义唯一，label 必填——红线 13/10） */
export interface ActivityItem {
  id: string
  icon: IconId
  label: string
  /** 未读数徽标（如日志错误数） */
  badge?: number
  /** 常驻主区：点击无动作，tooltip 追加「常驻主区」 */
  pinned?: boolean
  /** 可见/打开态（替换单值 activeId，支持多面板同时可见） */
  active?: boolean
}

/** 可停靠面板定义（标题用于面板头 / 浮窗 / 最小化条） */
export interface DockPanelDef {
  id: string
  title: string
}

/** 页签状态：正常 / 丢失（红）/ 未连接（灰化）——PersonalDb SPEC-UI-22 */
export type TabStatus = 'on' | 'lost' | 'off'

/** 页签定义：TabItemState + 展示字段 */
export interface UxTabDef extends TabItemState {
  icon?: IconId
  /** 资源/连接状态三态 */
  status?: TabStatus
  /** 第二行副标题（如 连接名@库），提供则双行展示 */
  subtitle?: string
  /** 标识色点（数据色，如连接色；由调用方取色，可为令牌 var 或哈希色） */
  accent?: string
}
