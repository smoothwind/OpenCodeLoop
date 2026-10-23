import { describe, expect, it } from 'vitest'
import { LogFileWriter } from '../src/main/daemon.js'
import { readOrphans, writeOrphans, runningList } from '../src/main/orphan.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('LogFileWriter（缓冲写入流）', () => {
  it('写入内容落盘并可追加', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocl-log-'))
    const file = join(dir, 'keep-alive.log')
    const w = new LogFileWriter()
    w.open(file)
    w.write('line1\n')
    w.write('line2\n')
    await new Promise((r) => setTimeout(r, 150))
    w.close()
    const text = await readFile(file, 'utf-8')
    expect(text).toContain('line1')
    expect(text).toContain('line2')
  })

  it('close 后再 write 不抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocl-log2-'))
    const w = new LogFileWriter()
    w.open(join(dir, 'a.log'))
    w.close()
    expect(() => w.write('ignored')).not.toThrow()
  })
})

describe('orphans 读写与快照', () => {
  it('写入后可读回，清空生效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocl-orphan-'))
    const file = join(dir, 'orphans.json')
    await writeOrphans(file, [{ pid: 123, taskName: 'A' }])
    expect(await readOrphans(file)).toEqual([{ pid: 123, taskName: 'A' }])
    await writeOrphans(file, [])
    expect(await readOrphans(file)).toEqual([])
  })

  it('文件不存在/损坏时返回空数组', async () => {
    expect(await readOrphans(join(tmpdir(), 'no-such-dir', 'orphans.json'))).toEqual([])
  })

  it('runningList 只收集运行/等待且有 pid 的任务', () => {
    const states = {
      a: { status: 'running', pid: 1 },
      b: { status: 'waiting', pid: 2 },
      c: { status: 'stopped', pid: 3 },
      d: { status: 'running', pid: null }
    }
    const list = runningList(states, (id) => id.toUpperCase())
    expect(list).toEqual([
      { pid: 1, taskId: 'a', taskName: 'A', startedAt: undefined },
      { pid: 2, taskId: 'b', taskName: 'B', startedAt: undefined }
    ])
  })
})
