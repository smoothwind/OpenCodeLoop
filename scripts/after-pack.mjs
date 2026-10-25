/**
 * scripts/after-pack.mjs — electron-builder 打包后裁剪 Electron 运行时
 *
 * 主进程与渲染层都不使用 WebGPU / DirectX 12（Dawn），因此删除仅由 Dawn 使用的
 * DXIL 着色器编译器（dxcompiler.dll 约 24.6 MB、dxil.dll 约 1.4 MB）。
 * 安装包可再减少约 6 MB；ANGLE/D3D11（WebGL、普通界面渲染）不受影响。
 *
 * 如后续需要 WebGPU，删除本文件中的 STRIP_FILES 或移除 electron-builder.yml 的 afterPack。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const STRIP_FILES = ['dxcompiler.dll', 'dxil.dll']

export default async function afterPack(context) {
  const removed = []
  for (const name of STRIP_FILES) {
    const file = join(context.appOutDir, name)
    try {
      rmSync(file, { force: true })
      removed.push(name)
    } catch {
      /* 文件不存在时忽略 */
    }
  }
  if (removed.length > 0) {
    console.log(`[after-pack] 已移除未使用的 Electron 组件：${removed.join(', ')}`)
  }
}
