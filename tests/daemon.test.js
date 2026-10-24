import { describe, expect, it } from 'vitest'
import {
  buildRunArgs,
  expandPrompt,
  isDone,
  initialState,
  Daemon,
  effectiveModels,
  pickModel,
  parseRunEvent
} from '../src/main/daemon.js'
import { taskDefaults, newTaskId, sanitizeTask } from '../src/main/store.js'
const baseCfg = () => ({
  ...taskDefaults(),
  id: 't1',
  project: 'D:\\proj',
  attachUrl: 'http://localhost:4096',
  sessionMode: 'last',
  sessionId: '',
  autoApprove: true,
  prompt: '继续任务，完成后输出 DONE'
})

describe('buildRunArgs', () => {
  it('基础参数序列与 keep-alive.ps1 一致（CLI 支持 --attach 时）', () => {
    const args = buildRunArgs(baseCfg(), { attach: true })
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto'])
    expect(args).toContain('--attach')
    expect(args).toContain('http://localhost:4096')
    expect(args).toContain('-c')
  })

  it('CLI 不支持 --attach 时不传（v2.1.x 已移除该 flag）', () => {
    const args = buildRunArgs(baseCfg(), {})
    expect(args).not.toContain('--attach')
    expect(args).toContain('-c')
    expect(buildRunArgs(baseCfg())).not.toContain('--attach')
  })

  it('手动审批不加 --auto', () => {
    const cfg = { ...baseCfg(), autoApprove: false }
    expect(buildRunArgs(cfg)).not.toContain('--auto')
  })

  it('指定会话用 -s，新会话不带会话参数', () => {
    expect(buildRunArgs({ ...baseCfg(), sessionMode: 'id', sessionId: 'ses_1' })).toContain('-s')
    const args = buildRunArgs({ ...baseCfg(), sessionMode: 'new' })
    expect(args).not.toContain('-s')
    expect(args).not.toContain('-c')
  })

  it('attachUrl 为空时不传 --attach', () => {
    expect(buildRunArgs({ ...baseCfg(), attachUrl: '' })).not.toContain('--attach')
  })
})

describe('expandPrompt', () => {
  it('替换 project/date/time 变量', () => {
    const out = expandPrompt('项目 {{project}} 于 {{date}} {{time}} 开始', { project: 'D:\\x' })
    expect(out).toContain('项目 D:\\x 于 ')
    expect(out).not.toContain('{{')
  })

  it('未知变量保持原样', () => {
    expect(expandPrompt('{{unknown}}', {})).toBe('{{unknown}}')
  })
})

describe('isDone', () => {
  it('子串匹配', () => {
    expect(isDone('任务已完成。DONE', 'DONE')).toBe(true)
    expect(isDone('继续工作中', 'DONE')).toBe(false)
  })
  it('空标记视为永不完成', () => {
    expect(isDone('DONE', '')).toBe(false)
  })
})

describe('模型链（主力 + 可选回退）', () => {
  const cfg = () => ({
    ...taskDefaults(),
    model: 'zhipu/glm-5.3-flash',
    fallbackModels: ['zhipu/glm-4.7', 'local/qwen3']
  })

  it('effectiveModels 去重去空、主力在前', () => {
    expect(effectiveModels({ model: 'a/b', fallbackModels: ['c/d', '', 'a/b'] })).toEqual(['a/b', 'c/d'])
    expect(effectiveModels({})).toEqual([])
  })

  it('pickModel：失败顺延、上限锁定末位', () => {
    expect(pickModel(cfg(), 0)).toBe('zhipu/glm-5.3-flash')
    expect(pickModel(cfg(), 1)).toBe('zhipu/glm-4.7')
    expect(pickModel(cfg(), 2)).toBe('local/qwen3')
    expect(pickModel(cfg(), 9)).toBe('local/qwen3')
  })

  it('无模型时不传 -m', () => {
    expect(buildRunArgs(taskDefaults(), { attach: true })).not.toContain('-m')
  })

  it('buildRunArgs 注入 -m 主力模型', () => {
    const args = buildRunArgs(cfg(), { attach: true }, 'zhipu/glm-5.3-flash')
    const i = args.indexOf('-m')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe('zhipu/glm-5.3-flash')
  })

  it('sanitizeTask 纠正 fallbackModels 为字符串数组', () => {
    const t = sanitizeTask({ id: 'a', fallbackModels: [' x/y ', 5, '', null] })
    expect(t.fallbackModels).toEqual(['x/y', '5'])
  })
})

describe('parseRunEvent（智能体交互事件解析）', () => {
  it('text 事件 → [AI] 语义条目', () => {
    const e = parseRunEvent(
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: '任务已完成\n第二行' } })
    )
    expect(e.level).toBe('info')
    expect(e.title.startsWith('[AI] 任务已完成')).toBe(true)
    expect(e.detail).toContain('第二行')
  })

  it('tool 事件 → [工具] 条目含状态与输入', () => {
    const e = parseRunEvent(
      JSON.stringify({
        type: 'tool',
        part: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'git status' } } }
      })
    )
    expect(e.title).toBe('[工具] bash · completed')
    expect(e.detail).toContain('git status')
  })

  it('error 事件 → error 级别', () => {
    const e = parseRunEvent(JSON.stringify({ type: 'error', message: '模型连接失败' }))
    expect(e.level).toBe('error')
    expect(e.title).toContain('模型连接失败')
  })

  it('opencode 原生错误事件（error.data.message + statusCode）→ 提取信息并供分类', () => {
    const raw = {
      type: 'error',
      timestamp: 1767036065000,
      sessionID: 'ses_q',
      error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429, isRetryable: true } }
    }
    const e = parseRunEvent(JSON.stringify(raw))
    expect(e.level).toBe('error')
    expect(e.title).toContain('Rate limit exceeded')
    expect(e.title).toContain('HTTP 429')
    expect(e.errorText).toContain('429')
  })

  it('工具失败（state.status=error）→ error 级并带 errorText', () => {
    const e = parseRunEvent(
      JSON.stringify({
        type: 'tool',
        part: { type: 'tool', tool: 'bash', state: { status: 'error', error: 'command failed with code 1' } }
      })
    )
    expect(e.level).toBe('error')
    expect(e.errorText).toContain('command failed')
  })

  it('step_start / reasoning 噪声 → skip（仅捕获 sessionId）', () => {
    const e = parseRunEvent(JSON.stringify({ type: 'step_start', sessionID: 'ses_x', part: {} }))
    expect(e).toMatchObject({ skip: true, sessionId: 'ses_x' })
    expect(parseRunEvent(JSON.stringify({ type: 'reasoning', part: {} })).skip).toBe(true)
  })

  it('非 JSON 行返回 null（按原始输出展示）', () => {
    expect(parseRunEvent('plain text output')).toBeNull()
    expect(parseRunEvent('')).toBeNull()
  })
})

describe('并发保护', () => {
  it('同一守护并发 start 只生效一次（防双进程/孤儿）', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-conc-'))
    const fake = join(proj, 'fake.cmd')
    await writeFile(fake, '@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho DONE\r\nexit /b 0\r\n', 'utf-8')
    const d = new Daemon()
    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      doneKeyword: 'DONE',
      retryDelay: 1,
      logFile: join(proj, 'l.log')
    }
    const bin = { path: fake, direct: false }
    const [r1, r2] = await Promise.all([d.start(cfg, bin), d.start(cfg, bin)])
    const oks = [r1, r2].filter((r) => r.ok).length
    expect(oks).toBe(1)
    // 等待完成
    for (let i = 0; i < 40 && !['done', 'error', 'stopped'].includes(d.state.status); i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    expect(d.state.runs).toBe(1)
    expect(d.state.status).toBe('done')
  }, 20000)
})

describe('托管服务端口冲突自动修复', () => {
  it('冲突输出触发修复器并自动重试，成功后完成', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-svc-'))
    const fake = join(proj, 'fake.cmd')
    const flag = join(proj, 'conflict.flag')
    // 第一轮：输出托管服务冲突并 exit 1；修复存根删除标志后，第二轮输出 DONE
    await writeFile(
      fake,
      '@echo off\r\nif exist conflict.flag (\r\n  echo ERROR Managed service port 45278 on 127.0.0.1 is already in use by another process.\r\n  exit /b 1\r\n) else (\r\n  echo DONE\r\n  exit /b 0\r\n)',
      'utf-8'
    )
    const d = new Daemon()
    let repairs = 0
    // 注入修复器：删除标志文件模拟"结束僵死服务"
    d.repairConflict = async () => {
      repairs++
      await rm(flag, { force: true })
      return { ok: true, pid: 4321 }
    }
    // 先放一个标志文件使首轮输出冲突
    await writeFile(flag, '1', 'utf-8')

    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      doneKeyword: 'DONE',
      onDone: 'next',
      maxRounds: 1,
      retryDelay: 1,
      logFile: join(proj, 'l.log')
    }
    await d.start(cfg, { path: fake, direct: false })
    for (let i = 0; i < 40 && !['done', 'error', 'stopped'].includes(d.state.status); i++) {
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(repairs).toBe(1)
    expect(d.state.runs).toBeGreaterThanOrEqual(2)
    expect(d.state.status).toBe('done')
    const titles = d.tail(60).map((l) => l.title)
    expect(titles.some((t) => t.includes('正在自动修复'))).toBe(true)
    expect(titles.some((t) => t.includes('僵死的 opencode 服务进程'))).toBe(true)
  }, 30000)
})

describe('错误分级处理策略（额度恢复 / 鉴权停止）', () => {
  const waitDone = (d, timeout = 30000) =>
    new Promise((resolve) => {
      const t0 = Date.now()
      const timer = setInterval(() => {
        if (['done', 'error', 'stopped'].includes(d.state.status) || Date.now() - t0 > timeout) {
          clearInterval(timer)
          resolve(d.state.status)
        }
      }, 200)
    })

  it('额度不足含恢复时间：无备选 → 等待恢复点自动拉起，不消耗重启次数', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-quota-'))
    const fake = join(proj, 'fake.cmd')
    // 第一轮：stderr 输出额度错误（含恢复时间）并 exit 1；第二轮输出 DONE
    await writeFile(
      fake,
      '@echo off\r\nif exist retry.flag (\r\n  del retry.flag\r\n  echo DONE\r\n  exit /b 0\r\n) else (\r\n  type nul > retry.flag\r\n  echo 套餐额度已用尽，将于 2099-01-01 00:00 恢复 1>&2\r\n  exit /b 1\r\n)',
      'utf-8'
    )
    const d = new Daemon({ policyMaxWaitMs: 1500 }) // 测试：等待封顶 1.5s
    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      doneKeyword: 'DONE',
      retryDelay: 1,
      logFile: join(proj, 'l.log')
    }
    await d.start(cfg, { path: fake, direct: false })
    const status = await waitDone(d)
    expect(status).toBe('done')
    expect(d.state.runs).toBe(2)
    expect(d.state.errorKind).toBe('quota')
    const titles = d.tail(60).map((l) => l.title)
    expect(titles.some((t) => t.includes('已排定') && t.includes('自动继续'))).toBe(true)
    // 等待期间曾出现恢复原因与等待状态
    expect(titles.some((t) => t.includes('额度不足'))).toBe(true)
  }, 40000)

  it('额度不足 + 备选模型 → 切换备选模型重试', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-quota2-'))
    const fake = join(proj, 'fake.cmd')
    await writeFile(
      fake,
      '@echo off\r\nif exist retry.flag (\r\n  del retry.flag\r\n  echo DONE\r\n  exit /b 0\r\n) else (\r\n  type nul > retry.flag\r\n  echo 模型请求额度不足，请稍后重试 1>&2\r\n  exit /b 1\r\n)',
      'utf-8'
    )
    const d = new Daemon()
    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      doneKeyword: 'DONE',
      model: 'a/primary',
      // 两个备选：首轮失败后仍有备选可切换（避免落到末端长退避）
      fallbackModels: ['b/fb1', 'b/fb2'],
      retryDelay: 1,
      logFile: join(proj, 'l.log')
    }
    await d.start(cfg, { path: fake, direct: false })
    const status = await waitDone(d)
    expect(status).toBe('done')
    // 失败轮已顺延到备选模型
    expect(d.state.model).toBe('b/fb1')
    expect(d.state.errorKind).toBe('quota')
  }, 40000)

  it('鉴权失败且无备选 → 守护明确停止并给出原因', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-auth-'))
    const fake = join(proj, 'fake.cmd')
    await writeFile(
      fake,
      '@echo off\r\necho unexpected status 401 Unauthorized 1>&2\r\nexit /b 1',
      'utf-8'
    )
    const d = new Daemon()
    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      retryDelay: 1,
      logFile: join(proj, 'l.log')
    }
    await d.start(cfg, { path: fake, direct: false })
    const status = await waitDone(d)
    expect(status).toBe('error')
    expect(d.state.runs).toBe(1)
    expect(d.state.errorKind).toBe('auth')
    expect(d.state.lastError).toContain('鉴权失败')
    expect(d.state.nextRestartAt).toBeNull()
  }, 40000)

  it('停止的守护清理等待状态，不再显示倒计时依据', async () => {
    const d = new Daemon()
    d.state.status = 'waiting'
    d.state.nextRestartAt = Date.now() + 60 * 1000
    d.state.waitReason = '额度不足，等待恢复后自动继续'
    d.stop('手动停止测试')
    expect(d.state.status).toBe('stopped')
    expect(d.state.nextRestartAt).toBeNull()
    expect(d.state.waitReason).toBe('')
  })
})

describe('Daemon 状态机（不真正 spawn：stop 于空闲态）', () => {
  it('初始为 stopped', () => {
    expect(initialState().status).toBe('stopped')
  })

  it('start 校验项目与二进制', async () => {
    const d = new Daemon()
    const r1 = await d.start({ ...baseCfg(), project: '' }, { path: 'x', direct: true })
    expect(r1.ok).toBe(false)
    const r2 = await d.start(baseCfg(), null)
    expect(r2.ok).toBe(false)
  })

  it('stop 在空闲态为幂等', () => {
    const d = new Daemon()
    expect(() => d.stop()).not.toThrow()
    expect(d.state.status).toBe('stopped')
  })

  it('日志环形缓冲封顶', () => {
    const d = new Daemon({ lineLimit: 5 })
    for (let i = 0; i < 10; i++) d.log('info', `m${i}`)
    expect(d.lines.length).toBe(5)
    expect(d.lines[0].title).toBe('m5')
  })

  it('newTaskId 唯一性', () => {
    const a = newTaskId()
    const b = newTaskId()
    expect(a).not.toBe(b)
    expect(a.startsWith('t_')).toBe(true)
  })
})
