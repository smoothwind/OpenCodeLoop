import type { IconId } from '../icon/registry'

/** 节点状态三态——与 UxTabs 同语义：on 正常 / lost 丢失（红）/ off 停用（灰化） */
export type TreeStatus = 'on' | 'lost' | 'off'

export interface TreeNodeData {
  id: string
  label: string
  children?: TreeNodeData[]
  /** 显式叶子：不渲染展开箭头、不参与懒加载 */
  leaf?: boolean
  icon?: IconId
  status?: TreeStatus
  /** 未读计数角标（缺省或 0 不显示，>99 显示 99+） */
  badge?: number
  disabled?: boolean
}

export type DropPosition = 'before' | 'after' | 'inside'

/** 右键菜单集成：组件只上报，不反向依赖 services（业务用 openContextMenuAt 承接） */
export interface NodeContextMenuPayload {
  node: TreeNodeData
  x: number
  y: number
}

export interface NodeMovePayload {
  dragId: string
  targetId: string
  position: DropPosition
}

/** 双击上报：组件只上报节点与原始事件，是否「打开」由业务决定（默认仍切换展开） */
export interface NodeDblclickPayload {
  node: TreeNodeData
  event: MouseEvent
}
