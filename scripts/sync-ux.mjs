#!/usr/bin/env node
/**
 * scripts/sync-ux.mjs — 从相邻 UX-FRW monorepo 同步源码到 vendor/uxkit/
 * 排除测试文件（__tests__ / .test.ts / .spec.ts）。
 *
 * 流程：先在临时目录完成全部复制与校验，再原子替换 vendor/uxkit——
 * 中途失败不会留下残缺的 vendor 目录（该目录被 git 跟踪，残缺会被误提交）。
 */
import { cpSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(root, '../UX-FRW/packages')
const DEST = resolve(root, 'vendor/uxkit')
const TMP = resolve(root, 'vendor/.uxkit-staging')
const PKGS = ['tokens', 'composables', 'services', 'components', 'shell', 'patterns']

if (!existsSync(SRC)) {
  console.error(`[sync-ux] 未找到上游目录：${SRC}（vendor/uxkit 保持不变）`)
  process.exit(1)
}

function hasTests(dir) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      // 坏链接等 stat 失败按文件处理
    }
    if (isDir) {
      if (name === '__tests__' || hasTests(p)) return true
    } else if (/(\.test|\.spec)\.[cm]?[jt]sx?$/.test(name)) {
      return true
    }
  }
  return false
}

// 阶段 1：复制到临时目录（离开前清掉上次可能残留的 staging）
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
let synced = 0
for (const pkg of PKGS) {
  const src = resolve(SRC, pkg, 'src')
  if (!existsSync(src)) {
    console.error(`[sync-ux] 缺少 ${pkg}/src，跳过`)
    continue
  }
  const dst = resolve(TMP, pkg, 'src')
  cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const base = basename(s)
      if (base === '__tests__') return false
      return !/(\.test|\.spec)\.[cm]?[jt]sx?$/.test(base)
    }
  })
  if (hasTests(dst)) {
    rmSync(TMP, { recursive: true, force: true })
    console.error(`[sync-ux] ${pkg} 仍含测试文件，请检查 filter 规则（vendor/uxkit 保持不变）`)
    process.exit(1)
  }
  console.log(`[sync-ux] ${pkg} 已同步`)
  synced++
}

if (synced === 0) {
  rmSync(TMP, { recursive: true, force: true })
  console.error('[sync-ux] 没有任何包被同步（vendor/uxkit 保持不变）')
  process.exit(1)
}

// 阶段 2：原子替换（同盘 rename）
rmSync(DEST, { recursive: true, force: true })
renameSync(TMP, DEST)
console.log(`[sync-ux] vendor/uxkit 更新完成（${synced}/${PKGS.length} 个包）`)
