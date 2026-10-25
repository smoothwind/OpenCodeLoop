import { inject, provide, ref, type InjectionKey, type Ref } from 'vue'

export type MessageTree = { [key: string]: string | MessageTree }

export interface I18nInstance {
  locale: Ref<string>
  availableLocales: string[]
  /** 点分 key 查找，支持 {name} 插值；缺失时回落 fallback 语言，再回落 key 本身 */
  t(key: string, params?: Record<string, string | number>): string
  setLocale(locale: string): void
}

export interface I18nOptions {
  locale: string
  fallback?: string
  messages: Record<string, MessageTree>
  onLocaleChange?: (locale: string) => void
}

function lookup(tree: MessageTree | undefined, path: string[]): string | undefined {
  let node: string | MessageTree | undefined = tree
  for (const seg of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = node[seg]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

/** 轻量 i18n（零依赖）：点分查找 + 插值 + 回落链 */
export function createI18n(options: I18nOptions): I18nInstance {
  const locale = ref(options.locale)
  const fallback = options.fallback ?? options.locale
  const availableLocales = Object.keys(options.messages)

  function t(key: string, params?: Record<string, string | number>): string {
    const path = key.split('.')
    const value =
      lookup(options.messages[locale.value], path) ?? lookup(options.messages[fallback], path)
    return interpolate(value ?? key, params)
  }

  function setLocale(next: string): void {
    if (!availableLocales.includes(next)) return
    locale.value = next
    options.onLocaleChange?.(next)
  }

  return { locale, availableLocales, t, setLocale }
}

const I18N_KEY: InjectionKey<I18nInstance> = Symbol('ux-i18n')

export function provideI18n(i18n: I18nInstance): void {
  provide(I18N_KEY, i18n)
}

export function useI18n(): I18nInstance {
  const i18n = inject(I18N_KEY)
  if (!i18n) {
    throw new Error('[UxI18n] 未找到 i18n 实例，请在应用根调用 provideI18n')
  }
  return i18n
}

/** 可选注入：无 i18n 时返回 null（供可选国际化的框架组件使用） */
export function tryUseI18n(): I18nInstance | null {
  return inject(I18N_KEY, null)
}
