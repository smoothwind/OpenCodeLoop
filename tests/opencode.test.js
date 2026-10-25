import { describe, expect, it } from 'vitest'
import {
  parseSessionList,
  stripJsonComments,
  normalizePermission,
  resolveBinary,
  exeFromShim,
  cmdQuote,
  parseSessionModel,
  normalizeApiSession,
  normalizeSessionProbe
} from '../src/main/opencode.js'
import { mergeConfig, defaultConfig, ConfigStore, sanitizeTask, taskFromLegacy, defaultConfig as dc } from '../src/main/store.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, writeFile } from 'node:fs/promises'

describe('parseSessionList', () => {
  it('解析 JSON 数组', () => {
    const text = JSON.stringify([
      { id: 'ses_a', title: '修复登录', updatedAt: 123 },
      { id: 'ses_b', title: '重构 API' }
    ])
    const list = parseSessionList(text)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ id: 'ses_a', title: '修复登录' })
  })

  it('解析表格行（UUID / ses_ 前缀）', () => {
    const text = [
      'ses_aaa1  修复登录  2m ago',
      '3f2b9c6e-8d1a-4c3e-b2f0-9a8b7c6d5e4f  重构 API  1h ago',
      '表头行没有 id'
    ].join('\n')
    const list = parseSessionList(text)
    expect(list.map((s) => s.id)).toEqual(['ses_aaa1', '3f2b9c6e-8d1a-4c3e-b2f0-9a8b7c6d5e4f'])
  })

  it('无会话返回空数组', () => {
    expect(parseSessionList('no sessions found')).toEqual([])
  })
})

describe('stripJsonComments', () => {
  it('剥离注释与尾逗号，保留字符串内容', () => {
    const src = `{
      // 行注释
      "url": "http://x//y", /* 块注释 */
      "arr": [1, 2,],
    }`
    const out = stripJsonComments(src)
    expect(() => JSON.parse(out)).not.toThrow()
    expect(JSON.parse(out).url).toBe('http://x//y')
    expect(JSON.parse(out).arr).toEqual([1, 2])
  })
})

describe('normalizePermission', () => {
  it('丢弃非法值并保留合法结构', () => {
    const p = normalizePermission({
      edit: 'allow',
      webfetch: 'nope',
      bash: { 'git push': 'deny', '': 'allow', 'git status': 'whatever' }
    })
    expect(p).toEqual({ edit: 'allow', bash: { 'git push': 'deny' } })
  })
})

describe('sanitizeTask / taskFromLegacy', () => {
  it('补全缺省、纠正类型、丢弃未知键', () => {
    const t = sanitizeTask({ id: 'a', retryDelay: '30', autoApprove: 0, unknown: 1 })
    expect(t.retryDelay).toBe(30)
    expect(t.autoApprove).toBe(false)
    expect('unknown' in t).toBe(false)
    expect(t.doneKeyword).toBe('DONE')
    // 会话等待上限：旧配置缺省补 30 分钟，显式值保留
    expect(t.sessionWaitLimitMin).toBe(30)
    expect(sanitizeTask({ id: 'b', sessionWaitLimitMin: '0' }).sessionWaitLimitMin).toBe(0)
  })

  it('名称缺省取项目目录名', () => {
    expect(sanitizeTask({ id: 'a', project: 'D:\\CodeRepos\\TerminalX' }).name).toBe('TerminalX')
  })

  it('v1 扁平配置迁移为单任务', () => {
    const t = taskFromLegacy({ project: 'D:\\CodeRepos\\X', autoApprove: true, autoStart: true, retryDelay: 60 })
    expect(t.name).toBe('X')
    expect(t.project).toBe('D:\\CodeRepos\\X')
    expect(t.autoStart).toBe(true)
    expect(t.retryDelay).toBe(60)
  })
})

describe('mergeConfig / ConfigStore', () => {
  it('tasks 整体替换并逐项 sanitize', () => {
    const merged = mergeConfig(dc(), { tasks: [{ id: 'a', retryDelay: '30', autoApprove: 0 }] })
    expect(merged.tasks).toHaveLength(1)
    expect(merged.tasks[0].retryDelay).toBe(30)
    expect(merged.tasks[0].autoApprove).toBe(false)
  })

  it('全局字段类型纠正', () => {
    const merged = mergeConfig(defaultConfig(), { closeToTray: 0 })
    expect(merged.closeToTray).toBe(false)
  })

  it('对象字段（windowBounds）原样通过', () => {
    const b = { x: 10, y: 20, width: 1180, height: 800 }
    const merged = mergeConfig(defaultConfig(), { windowBounds: b })
    expect(merged.windowBounds).toEqual(b)
    expect(mergeConfig(defaultConfig(), {}).windowBounds).toBeNull()
  })

  it('损坏的配置文件回退缺省并迁移出默认任务', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocl-'))
    const file = join(dir, 'config.json')
    await writeFile(file, '{broken json', 'utf-8')
    const store = new ConfigStore(file)
    const data = await store.load()
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].doneKeyword).toBe('DONE')
  })

  it('v1 配置自动迁移为任务并写回', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocl-'))
    const file = join(dir, 'config.json')
    await writeFile(file, JSON.stringify({ project: 'D:\\CodeRepos\\Legacy', autoApprove: false }), 'utf-8')
    const store = new ConfigStore(file)
    const data = await store.load()
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].project).toBe('D:\\CodeRepos\\Legacy')
    expect(data.tasks[0].name).toBe('Legacy')
    expect(data.tasks[0].autoApprove).toBe(false)
    // 迁移结果已持久化
    const raw = JSON.parse(await writeFile2read(file))
    expect(raw.tasks).toHaveLength(1)
    async function writeFile2read(f) {
      const { readFile } = await import('node:fs/promises')
      return readFile(f, 'utf-8')
    }
  })
})

describe('parseSessionModel（会话实际模型）', () => {
  it('取最后一条 assistant 消息的 provider/model', () => {
    const json = JSON.stringify({
      messages: [
        { type: 'user', text: 'hi' },
        { type: 'assistant', model: { id: 'glm-4.7', providerID: 'zhipu' } },
        { type: 'idle' },
        { type: 'assistant', model: { id: 'glm-5.3-flash', providerID: 'zhipu' } }
      ]
    })
    expect(parseSessionModel(json)).toBe('zhipu/glm-5.3-flash')
  })

  it('无 assistant 消息返回空串', () => {
    expect(parseSessionModel(JSON.stringify({ messages: [{ type: 'user' }] }))).toBe('')
    expect(parseSessionModel('')).toBe('')
  })

  it('非 JSON 输出用正则兜底', () => {
    const text = 'garbage {"type":"assistant","model":{"id":"flint-40b-free","providerID":"opencode"}} tail'
    expect(parseSessionModel(text)).toBe('opencode/flint-40b-free')
  })
})

describe('normalizeApiSession（API 会话归一化）', () => {
  it('提取标题/目录/模型/时间', () => {
    const s = normalizeApiSession({
      id: 'ses_1',
      title: '设计前后端一体化ETL系统',
      projectID: 'p1',
      model: { id: 'glm-5.3-flash', providerID: 'zhipuai-coding-plan', variant: 'default' },
      time: { created: 1, updated: 2 },
      outcome: 'succeeded',
      location: { directory: 'D:\\CodeRepos\\MonoETL' }
    })
    expect(s).toMatchObject({
      id: 'ses_1',
      title: '设计前后端一体化ETL系统',
      dir: 'D:\\CodeRepos\\MonoETL',
      model: 'zhipuai-coding-plan/glm-5.3-flash',
      updated: 2
    })
  })

  it('缺字段容错', () => {
    const s = normalizeApiSession({ id: 'ses_2' })
    expect(s).toMatchObject({ id: 'ses_2', title: '', dir: '', model: '', updated: null })
    expect(normalizeApiSession(null).id).toBe('')
  })
})

describe('normalizeSessionProbe（会话状态探测归一化）', () => {
  it('active 只认当前会话；inbox 取长度；outcome/time 仅用于展示', () => {
    const p = normalizeSessionProbe(
      'ses_a',
      { ses_a: { type: 'running' }, ses_b: { type: 'running' } },
      { outcome: 'failed', time: { idle: 123, updated: 456 } },
      [{ id: 'i1' }, { id: 'i2' }]
    )
    expect(p.active).toBe(true)
    expect(p.inbox).toBe(2)
    expect(p.outcome).toBe('failed')
    expect(p.idleAt).toBe(123)
    expect(p.updatedAt).toBe(456)
  })

  it('缺字段时安全降级；inbox 缺失按 0 处理', () => {
    expect(normalizeSessionProbe('ses_a', null, null, null)).toEqual({
      active: false,
      inbox: 0,
      outcome: '',
      idleAt: 0,
      updatedAt: 0
    })
    expect(normalizeSessionProbe('ses_a', { ses_b: { type: 'running' } }, undefined, []).active).toBe(false)
  })
})

describe('resolveBinary（绝对路径分支）', () => {
  it('不存在的绝对路径返回 null', async () => {
    expect(await resolveBinary('Z:\\definitely\\missing\\opencode.exe')).toBeNull()
  })
})
