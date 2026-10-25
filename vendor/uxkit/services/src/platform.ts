export interface WindowControls {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}

export interface PlatformAdapter {
  /** 宿主标识：'electron' | 'tauri' | 'web' | 自定义 */
  name: string
  os?: 'win32' | 'darwin' | 'linux'
  /** 提供后 TitleBar 显示窗控按钮（frameless 模式） */
  windowControls?: WindowControls
}

let current: PlatformAdapter | null = null

/** 注入宿主适配器（createUxKit 或 main.ts 调用）；传 null 清除 */
export function setPlatformAdapter(adapter: PlatformAdapter | null): void {
  current = adapter
}

export function getPlatformAdapter(): PlatformAdapter | null {
  return current
}

/**
 * 浏览器近似窗控（仅供演示/在浏览器中预览 frameless 壳）：
 * 最大化以全屏模拟，其余为安全空操作。
 */
export function createWebWindowControls(): WindowControls {
  return {
    minimize(): void {
      /* 浏览器无最小化能力 */
    },
    toggleMaximize(): void {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen()
    },
    close(): void {
      window.close()
    },
    isMaximized(): Promise<boolean> {
      return Promise.resolve(!!document.fullscreenElement)
    },
    onMaximizedChange(listener: (maximized: boolean) => void): () => void {
      const handler = (): void => listener(!!document.fullscreenElement)
      document.addEventListener('fullscreenchange', handler)
      return () => document.removeEventListener('fullscreenchange', handler)
    },
  }
}
