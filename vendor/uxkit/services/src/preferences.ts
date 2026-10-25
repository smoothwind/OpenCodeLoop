import { ref, watch, type Ref } from 'vue'

export interface PreferencesOptions<T extends Record<string, unknown>> {
  /** localStorage key（单一入口，杜绝碎片化） */
  key: string
  /** 当前数据版本号，用于迁移 */
  version: number
  defaults: T
  /** 从旧版本迁移（返回迁移后的数据） */
  migrate?: (fromVersion: number, data: Record<string, unknown>) => Record<string, unknown>
  /** 持久化防抖毫秒，默认 150 */
  debounce?: number
}

export interface Preferences<T extends Record<string, unknown>> {
  state: Ref<T>
  patch(partial: Partial<T>): void
  set<K extends keyof T>(key: K, value: T[K]): void
  reset(): void
}

interface PersistedEnvelope {
  __version: number
  data: Record<string, unknown>
}

/**
 * 版本化偏好存储：单一 key + 版本号 + 迁移链 + 缺省兜底合并。
 * 变更即持久化（防抖），业务直接把 state 当响应式对象用。
 */
export function createPreferences<T extends Record<string, unknown>>(
  options: PreferencesOptions<T>,
): Preferences<T> {
  const { key, version, defaults, migrate, debounce = 150 } = options

  function load(): T {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return { ...defaults }
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return { ...defaults }
      const record = parsed as Record<string, unknown>
      if ('__version' in record) {
        const envelope = record as unknown as PersistedEnvelope
        let data = envelope.data ?? {}
        if (envelope.__version < version && migrate) {
          data = migrate(envelope.__version, data)
        }
        return { ...defaults, ...data }
      }
      const data = migrate ? migrate(0, record) : record
      return { ...defaults, ...data }
    } catch {
      return { ...defaults }
    }
  }

  const state = ref(load()) as Ref<T>

  let timer: number | undefined
  function persist(): void {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const envelope: PersistedEnvelope = { __version: version, data: state.value }
      try {
        localStorage.setItem(key, JSON.stringify(envelope))
      } catch (error) {
        console.warn('[UxPreferences] 持久化失败：', error)
      }
    }, debounce)
  }

  watch(state, persist, { deep: true })

  return {
    state,
    patch(partial: Partial<T>): void {
      state.value = { ...state.value, ...partial }
    },
    set<K extends keyof T>(key: K, value: T[K]): void {
      state.value = { ...state.value, [key]: value }
    },
    reset(): void {
      state.value = { ...defaults }
    },
  }
}
