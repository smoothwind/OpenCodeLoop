/**
 * scripts/ux-aliases.mjs — @ux/* 别名解析
 * 优先级：
 *   1. ../UX-FRW（本地开发，源码直连）
 *   2. vendor/uxkit（CI 环境，用 `npm run sync-ux` 生成与更新）
 * 注意：子路径样式（.css）必须置于包名之前，否则被宽匹配吞掉。
 */
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = resolve(root, '../UX-FRW/packages')
const VENDOR = resolve(root, 'vendor/uxkit')

export function uxBase() {
  if (process.env.FORCE_VENDORED_UX === '1') return VENDOR
  return existsSync(UPSTREAM) ? UPSTREAM : VENDOR
}

export function uxAliases() {
  const base = uxBase()
  const f = (pkg, file) => resolve(base, pkg, 'src', file)
  return [
    { find: '@ux/tokens/tokens.css', replacement: f('tokens', 'index.css') },
    { find: '@ux/components/styles.css', replacement: f('components', 'styles.css') },
    { find: '@ux/shell/styles.css', replacement: f('shell', 'styles.css') },
    { find: '@ux/patterns/styles.css', replacement: f('patterns', 'styles.css') },
    { find: '@ux/tokens', replacement: f('tokens', 'index.ts') },
    { find: '@ux/composables', replacement: f('composables', 'index.ts') },
    { find: '@ux/services', replacement: f('services', 'index.ts') },
    { find: '@ux/components', replacement: f('components', 'index.ts') },
    { find: '@ux/shell', replacement: f('shell', 'index.ts') },
    { find: '@ux/patterns', replacement: f('patterns', 'index.ts') }
  ]
}
