#!/usr/bin/env node
/**
 * scripts/dist-win.mjs — Windows 安装包一键构建（electron-vite build + electron-builder --win）
 *
 * 在标准环境下等价于 `electron-vite build && electron-builder --win`；
 * 另外自动规避本机（VMware 共享目录）上的三个问题：
 *
 *  1. Vite 的 safeRealpath 会用 `net use` 输出建立 UNC→盘符映射，正则是 `(\w:) +([^ ]+)`，
 *     共享名含空格（如 \\vmware-host\Shared Folders）时只截到 `\\vmware-host\Shared`，
 *     导致真实路径被错拼成 `Z: Folders\VM_CodeRepo\...`（ENOENT）。见 vite#…
 *     处理：构建前临时用 net.cmd 屏蔽 `net use`，让 Vite 退回 fs.realpathSync.native。
 *
 *  2. node_modules/electron/dist 缺失（安装脚本被 npm allowScripts 拦截、或 GitHub Release 下载受阻）时，
 *     回退到 %LOCALAPPDATA%\electron\Cache 里已缓存的 electron-v*-win32-x64.zip，
 *     解压到本地临时目录，通过 --config.electronDist 交给 electron-builder。
 *
 *  3. 项目位于网络盘（映射盘/UNC）时，electron-builder 先输出到本地临时目录，完成后仅把安装包回拷 dist/，
 *     避免在共享目录写入数百 MB 小文件。
 *
 * 用法：npm run dist
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const tmp = os.tmpdir()

function log(msg) {
  console.log(`[dist] ${msg}`)
}

function fail(msg) {
  console.error(`[dist] 失败：${msg}`)
  process.exit(1)
}

function run(bin, args, env) {
  const r = spawnSync(bin, args, { cwd: root, stdio: 'inherit', env })
  if (r.error) fail(`${bin} 启动失败：${r.error.message}`)
  if (r.status !== 0) fail(`${bin} 退出码 ${r.status}`)
}

/** 项目是否位于网络盘（映射盘经 realpath 后为 \\\\server\\share） */
function isNetworkPath(dir) {
  try {
    return /^\\\\/.test(realpathNative(dir))
  } catch {
    return /^\\\\/.test(dir)
  }
}

function realpathNative(dir) {
  try {
    return existsSync(dir) ? realpathSync.native(dir) : dir
  } catch {
    return dir
  }
}

/** Vite 在含空格共享名上的 net use 误映射规避：构造一个只返回失败码的 net.cmd */
function prepareFakeNet(env) {
  if (!isWin) return
  const dir = join(tmp, 'opencodeloop-fakenet')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'net.cmd'), '@exit /b 1\r\n')
  env.PATH = `${dir};${env.PATH ?? process.env.PATH ?? ''}`
}

/** 解析 electron 版本号，用于在缓存中挑选最接近的 zip */
function parseVersion(v) {
  return String(v)
    .split(/[.+-]/)
    .slice(0, 3)
    .map((n) => Number.parseInt(n, 10) || 0)
}

function compareVersion(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * 返回 electron-builder 可用的未打包 Electron 目录。
 * 优先 node_modules/electron/dist，其次缓存 zip 解压到本地临时目录。
 */
function resolveElectronDist() {
  const pkgPath = join(root, 'node_modules', 'electron', 'package.json')
  let wanted = null
  try {
    wanted = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf-8')).version : null
  } catch {
    // package.json 损坏时按未知版本处理，走缓存/下载兜底
    wanted = null
  }
  const installed = join(root, 'node_modules', 'electron', 'dist')

  if (existsSync(join(installed, 'electron.exe'))) {
    log(`使用 node_modules/electron/dist（${wanted ?? '未知版本'}）`)
    return { dir: installed, version: wanted }
  }

  const cacheRoot =
    process.env.LOCALAPPDATA ?? join(os.homedir(), 'AppData', 'Local')
  const cacheDir = join(cacheRoot, 'electron', 'Cache')
  const candidates = []
  if (existsSync(cacheDir)) {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const file of readdirSync(join(cacheDir, entry.name))) {
        const m = /^electron-v(.+)-win32-x64\.zip$/.exec(file)
        if (m) candidates.push({ version: m[1], zip: join(cacheDir, entry.name, file) })
      }
    }
  }

  if (candidates.length === 0) {
    log('未找到可用的 Electron 运行时，交给 electron-builder 自行下载')
    return null
  }

  candidates.sort((a, b) => compareVersion(b.version, a.version))
  const picked = wanted
    ? candidates.find((c) => c.version === wanted) ?? candidates[0]
    : candidates[0]

  if (wanted && picked.version !== wanted) {
    // 版本不匹配 = 未经测试的运行时组合，产物版本与 lockfile 不一致；CI 下无人看日志，
    // 静默降级会让错误组合直接发布。确需放行时显式设置 ALLOW_ELECTRON_MISMATCH=1。
    const msg = `缓存中没有 electron ${wanted}（node_modules/electron 版本），只有 ${candidates
      .slice(0, 3)
      .map((c) => `v${c.version}`)
      .join(' / ')}；拒绝用不匹配版本打包`
    if (process.env.ALLOW_ELECTRON_MISMATCH === '1') {
      log(`警告：${msg}（ALLOW_ELECTRON_MISMATCH=1 已放行）`)
    } else {
      fail(`${msg}。修复：npm install 重装 electron，或清理 %LOCALAPPDATA%\\electron\\Cache，或设置 ALLOW_ELECTRON_MISMATCH=1`)
    }
  }

  const dest = join(tmp, `opencodeloop-electron-${picked.version}`)
  if (!existsSync(join(dest, 'electron.exe'))) {
    log(`解压缓存运行时 ${picked.version} → ${dest}`)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    const ps = `Expand-Archive -LiteralPath '${picked.zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], process.env)
    if (!existsSync(join(dest, 'electron.exe'))) fail(`解压后未找到 electron.exe：${dest}`)
  } else {
    log(`复用已解压运行时 ${dest}`)
  }
  return { dir: dest, version: picked.version }
}

/** 网络盘：输出先落本地，最后回拷 dist/ */
function prepareOutput() {
  const network = isNetworkPath(root)
  const dist = join(root, 'dist')
  const staging = network ? join(tmp, 'opencodeloop-dist') : dist
  if (network) {
    log(`网络路径，产物暂存 ${staging}`)
    rmSync(staging, { recursive: true, force: true })
  }
  return { dist, staging, network }
}

/** 把暂存目录里的安装包回拷到 dist/，文件名空格转连字符（与 latest.yml 一致）。
 *  过滤规则与本地分支一致：仅安装包 / blockmap / latest.yml。 */
function copyArtifacts(staging, dist) {
  mkdirSync(dist, { recursive: true })
  const copied = []
  for (const entry of readdirSync(staging, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!(entry.name.endsWith('.exe') || entry.name.endsWith('.blockmap') || entry.name === 'latest.yml')) continue
    const target = join(dist, entry.name.replace(/ /g, '-'))
    copyFileSync(join(staging, entry.name), target)
    copied.push(target)
  }
  return copied
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase()
}

function main() {
  const env = { ...process.env }
  prepareFakeNet(env)

  log('构建渲染层与主进程（electron-vite build）')
  run(process.execPath, [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], env)

  const electron = resolveElectronDist()
  const { dist, staging, network } = prepareOutput()

  // 显式 --publish never：CI（tag 构建）下 electron-builder 默认会尝试上传 GitHub Release，
  // 本项目由 GitHub Actions 的 softprops/action-gh-release 统一发布，避免重复发布/缺少 token 报错
  const args = [join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--publish', 'never']
  if (electron) args.push(`--config.electronDist=${electron.dir}`)
  if (network) args.push(`--config.directories.output=${staging}`)

  log(`打包安装包（electron-builder --win --publish never${electron ? `，runtime ${electron.version ?? '?'}` : ''}）`)
  run(process.execPath, args, env)

  const files = network ? copyArtifacts(staging, dist) : readdirSync(dist)
    .filter((n) => n.endsWith('.exe') || n.endsWith('.blockmap') || n === 'latest.yml')
    .map((n) => join(dist, n))

  for (const file of files) {
    const s = statSync(file)
    log(`${file}  ${(s.size / 1024 / 1024).toFixed(1)} MB  SHA256 ${sha256(file)}`)
  }
  if (files.length === 0) fail('未生成任何安装包产物')
  log('完成')
}

main()
