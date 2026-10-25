import type { ApplyThemeOptions, ResolvedTheme, UxTheme } from './types'

export type { ApplyThemeOptions, ResolvedTheme, UxTheme } from './types'

/** 文档根元素上的主题标记（Primer 约定） */
export const THEME_ATTR = 'data-color-mode'
/** 暗色类名（Element Plus/主流库约定，双通道兼容） */
export const DARK_CLASS = 'dark'

/** 跟随系统偏好时监听的媒体查询 */
const SYSTEM_QUERY = '(prefers-color-scheme: dark)'

export function resolveTheme(theme: UxTheme): ResolvedTheme {
  if (theme !== 'system') return theme
  return window.matchMedia(SYSTEM_QUERY).matches ? 'dark' : 'light'
}

/**
 * 应用主题到文档根元素。
 * 三通道同步：data-color-mode（Primer）+ .dark 类（EP/主流库）+ color-scheme（原生控件）。
 */
export function applyTheme(theme: UxTheme, options: ApplyThemeOptions = {}): ResolvedTheme {
  const resolved = resolveTheme(theme)
  const root = document.documentElement
  root.setAttribute(THEME_ATTR, resolved)
  root.classList.toggle(DARK_CLASS, resolved === 'dark')
  root.style.colorScheme = resolved
  options.syncPlatform?.(resolved)
  return resolved
}

/** 监听系统主题变化，仅在用户选择 system 时回调 resolved 结果 */
export function watchSystemTheme(cb: (resolved: ResolvedTheme) => void): () => void {
  const mql = window.matchMedia(SYSTEM_QUERY)
  const handler = (): void => cb(resolveTheme('system'))
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}

/** 运行时读取令牌值（图表/画布等 JS 场景专用，禁止 JS 分支硬编码颜色） */
export function getToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** token 名常量：避免业务代码中出现魔法字符串 */
export const tokenNames = {
  fs: {
    xs: '--ux-fs-xs',
    sm: '--ux-fs-sm',
    md: '--ux-fs-md',
    lg: '--ux-fs-lg',
    xl: '--ux-fs-xl',
    display: '--ux-fs-display',
  },
  sp: {
    1: '--ux-sp-1',
    2: '--ux-sp-2',
    3: '--ux-sp-3',
    4: '--ux-sp-4',
    5: '--ux-sp-5',
    6: '--ux-sp-6',
  },
  z: {
    local: '--ux-z-local',
    dock: '--ux-z-dock',
    pop: '--ux-z-pop',
    top: '--ux-z-top',
    modal: '--ux-z-modal',
    menu: '--ux-z-menu',
    dropdown: '--ux-z-dropdown',
    tour: '--ux-z-tour',
    toast: '--ux-z-toast',
  },
  color: {
    accent: '--ux-accent',
    bg: '--ux-bg',
    fg: '--ux-fg',
    border: '--ux-border',
    danger: '--ux-danger',
    success: '--ux-success',
    warning: '--ux-warning',
    info: '--ux-info',
  },
} as const
