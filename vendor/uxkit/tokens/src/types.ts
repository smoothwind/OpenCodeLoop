export type UxTheme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ApplyThemeOptions {
  /** 主题解析后回调宿主（Electron nativeTheme / Tauri set_theme），保持原生标题栏/菜单同步 */
  syncPlatform?: (theme: ResolvedTheme) => void
}
