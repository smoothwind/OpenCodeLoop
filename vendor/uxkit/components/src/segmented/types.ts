import type { IconId } from '../icon/registry'

export interface SegmentedOption {
  value: string
  label?: string
  icon?: IconId
  disabled?: boolean
  /** 仅图标选项的无障碍名称（红线 10）；同时作为 title */
  ariaLabel?: string
}
