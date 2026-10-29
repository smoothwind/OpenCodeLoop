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

  it('供应商 rate-limit 事件（response.body 内嵌业务码 1308）→ 可读文案 + 可分类', () => {
    const message = '已达到 5 小时的使用上限。您的限额将在 2026-10-25 18:48:03 重置。'
    const e = parseRunEvent(
      JSON.stringify({
        type: 'error',
        timestamp: 1792922353847,
        sessionID: 'ses_ea147f3edffdInxJ4GTwJkuNe7',
        error: {
          type: 'provider.rate-limit',
          message,
          status: 429,
          response: { body: JSON.stringify({ error: { code: '1308', message } }) }
        }
      })
    )
    expect(e.level).toBe('error')
    expect(e.title).toContain('5 小时的使用上限')
    expect(e.title).toContain('HTTP 429')
    expect(e.title).toContain('1308')
    expect(e.title).not.toContain('未知错误')
    expect(e.errorText).toContain('1308')
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

describe('会话闸门（等待 TUI/其他客户端空闲）', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  async function setupFake(files = {}) {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-gate-'))
    const fake = join(proj, 'fake.cmd')
    await writeFile(fake, files.cmd || '@echo off\r\necho DONE\r\nexit /b 0\r\n', 'utf-8')
    return { proj, fake, join }
  }

  const baseCfg = (proj, join) => ({
    ...taskDefaults(),
    id: 't',
    project: proj,
    attachUrl: '',
    sessionMode: 'id',
    sessionId: 'ses_test',
    prompt: 'x',
    doneKeyword: 'DONE',
    retryDelay: 1,
    logFile: join(proj, 'l.log')
  })

  it('会话有排队消息：先等待，空闲后才发送（日志包含排队条数）', async () => {
    const { proj, fake, join } = await setupFake()
    let inboxCount = 2
    let observedEmpty = false
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => {
        if (inboxCount === 0) observedEmpty = true
        return { ok: true, active: false, inbox: inboxCount, outcome: 'succeeded' }
      },
      waitSessionIdle: async () => {
        await sleep(20)
        return { ok: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'waiting'; i++) await sleep(20)
    expect(d.state.status).toBe('waiting')
    expect(d.state.runs).toBe(0)
    expect(d.state.waitReason).toContain('排队消息')
    const titles = d.tail(80).map((l) => l.title)
    expect(titles.some((t) => t.includes('2 条排队消息'))).toBe(true)

    inboxCount = 0
    for (let i = 0; i < 120 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
    expect(observedEmpty).toBe(true)
    expect(d.tail(80).map((l) => l.title).some((t) => t.includes('已空闲'))).toBe(true)
  }, 25000)

  it('等待超过上限后按配置继续发送', async () => {
    const { proj, fake, join } = await setupFake()
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: true, inbox: 0, outcome: 'succeeded' }),
      waitSessionIdle: async () => {
        await sleep(30)
        return { ok: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    const cfg = { ...baseCfg(proj, join), sessionWaitLimitMin: 0.02 } // 约 1.2 秒
    await d.start(cfg, { path: fake, direct: false })
    for (let i = 0; i < 160 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
    expect(d.tail(120).map((l) => l.title).some((t) => t.includes('超过上限'))).toBe(true)
  }, 25000)

  it('等待超过上限后按配置停止守护（sessionWaitTimeoutAction=stop）', async () => {
    const { proj, fake, join } = await setupFake()
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: true, inbox: 0, outcome: 'succeeded' }),
      waitSessionIdle: async () => {
        await sleep(30)
        return { ok: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    const cfg = { ...baseCfg(proj, join), sessionWaitLimitMin: 0.02, sessionWaitTimeoutAction: 'stop' }
    await d.start(cfg, { path: fake, direct: false })
    for (let i = 0; i < 160 && d.state.status !== 'stopped'; i++) await sleep(50)
    expect(d.state.status).toBe('stopped')
    expect(d.state.runs).toBe(0)
    const titles = d.tail(120).map((l) => l.title)
    expect(titles.some((t) => t.includes('按配置停止守护'))).toBe(true)
    expect(titles.some((t) => t.includes('会话等待超时'))).toBe(true)
  }, 25000)

  it('等待期“跳过等待”：本轮不再等待直接发送', async () => {
    const { proj, fake, join } = await setupFake()
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: true, inbox: 0, outcome: 'succeeded' }),
      waitSessionIdle: async () => {
        await sleep(30)
        return { ok: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'waiting'; i++) await sleep(20)
    expect(d.state.status).toBe('waiting')
    const r = d.skipWait()
    expect(r.ok).toBe(true)
    for (let i = 0; i < 120 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
    expect(d.tail(120).map((l) => l.title).some((t) => t.includes('已跳过会话等待'))).toBe(true)
  }, 25000)

  it('等待期“中断会话”：打断目标回合后自动放行', async () => {
    const { proj, fake, join } = await setupFake()
    let targetBusy = true
    const interrupted = []
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: targetBusy, inbox: 0, outcome: 'succeeded' }),
      waitSessionIdle: async () => {
        await sleep(30)
        return { ok: true }
      },
      interruptSession: async (sid) => {
        interrupted.push(sid)
        targetBusy = false
        return { ok: true, interrupted: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'waiting'; i++) await sleep(20)
    expect(d.state.status).toBe('waiting')
    const r = await d.interruptTargetSession()
    expect(r.ok).toBe(true)
    expect(interrupted).toEqual(['ses_test'])
    for (let i = 0; i < 120 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
    expect(d.tail(120).map((l) => l.title).some((t) => t.includes('已中断服务器端会话执行'))).toBe(true)
  }, 25000)

  it('等待期处置仅在会话闸门等待中可用', async () => {
    const { proj, fake, join } = await setupFake()
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: false, inbox: 0, outcome: 'succeeded' })
    })
    expect(d.skipWait().ok).toBe(false)
    expect((await d.interruptTargetSession()).ok).toBe(false)
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 80 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    // 结束后同样不可用
    expect(d.skipWait().ok).toBe(false)
  }, 20000)

  it('sanitizeTask：等待超时处置仅接受 stop，其余回退 send', () => {
    expect(sanitizeTask({ id: 'a' }).sessionWaitTimeoutAction).toBe('send')
    expect(sanitizeTask({ id: 'a', sessionWaitTimeoutAction: 'stop' }).sessionWaitTimeoutAction).toBe('stop')
    expect(sanitizeTask({ id: 'a', sessionWaitTimeoutAction: 'bogus' }).sessionWaitTimeoutAction).toBe('send')
  })

  it('等待期间停止：不发送、不再探测后续轮次', async () => {
    const { proj, fake, join } = await setupFake()
    let probes = 0
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => {
        probes++
        return { ok: true, active: true, inbox: 0, outcome: 'failed' }
      },
      waitSessionIdle: async () => {
        await sleep(50)
        return { ok: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'waiting'; i++) await sleep(20)
    d.stop('测试停止')
    const atStop = probes
    await sleep(400)
    expect(d.state.status).toBe('stopped')
    expect(d.state.runs).toBe(0)
    // 允许停止瞬间已在途的一次探测，但之后不得再继续轮询
    expect(probes).toBeLessThanOrEqual(atStop + 1)
  }, 20000)

  it('等待期间“立即重启”：重新探测而不结束守护', async () => {
    const { proj, fake, join } = await setupFake()
    let inboxCount = 1
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: false, inbox: inboxCount, outcome: 'succeeded' }),
      waitSessionIdle: (sid, { signal }) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true }), 5000)
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve({ ok: false, aborted: true })
            },
            { once: true }
          )
        }),
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'waiting'; i++) await sleep(20)
    expect(d.state.status).toBe('waiting')
    d.restartNow()
    await sleep(250)
    expect(d.state.status).toBe('waiting')
    expect(d.state.runs).toBe(0)

    inboxCount = 0
    d.restartNow()
    for (let i = 0; i < 80 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
  }, 20000)

  it('API 不可用：记录警告后退回直接发送', async () => {
    const { proj, fake, join } = await setupFake()
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: false, error: 'no service' }),
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 80 && d.state.status !== 'done'; i++) await sleep(50)
    expect(d.state.status).toBe('done')
    expect(d.state.runs).toBe(1)
    expect(d.tail(60).map((l) => l.title).some((t) => t.includes('跳过等待直接发送'))).toBe(true)
  }, 20000)

  it('停止运行中的守护：请求中断服务器端执行', async () => {
    const { proj, fake, join } = await setupFake({
      cmd: '@echo off\r\nping -n 8 127.0.0.1 >nul\r\necho DONE\r\nexit /b 0\r\n'
    })
    const interrupted = []
    const d = new Daemon({
      resolveSession: async () => 'ses_test',
      probeSession: async () => ({ ok: true, active: false, inbox: 0, outcome: 'succeeded' }),
      interruptSession: async (sid) => {
        interrupted.push(sid)
        return { ok: true, interrupted: true }
      },
      acquireSession: () => ({ ok: true }),
      releaseSession: () => {}
    })
    await d.start(baseCfg(proj, join), { path: fake, direct: false })
    for (let i = 0; i < 50 && d.state.status !== 'running'; i++) await sleep(20)
    expect(d.state.status).toBe('running')
    d.stop('测试停止')
    for (let i = 0; i < 20 && !interrupted.length; i++) await sleep(20)
    expect(interrupted).toEqual(['ses_test'])
    expect(d.tail(60).map((l) => l.title).some((t) => t.includes('已中断服务器端会话执行'))).toBe(true)
  }, 20000)
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

describe('立即重启（运行中）', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  it('运行中点立即重启：终止当前轮后跳过重启延时直接进入下一轮', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const proj = await mkdtemp(join(tmpdir(), 'ocl-restart-'))
    const fake = join(proj, 'fake.cmd')
    // 每轮跑约 2 秒且不输出 DONE（保证退出后存在重启等待环节）
    await writeFile(fake, '@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho still working\r\nexit /b 0\r\n', 'utf-8')
    const d = new Daemon()
    const cfg = {
      ...taskDefaults(),
      id: 't',
      project: proj,
      attachUrl: '',
      sessionMode: 'new',
      prompt: 'x',
      doneKeyword: 'DONE',
      retryDelay: 8, // 未消费 skipDelay 时：终止当前轮后需等 8 秒才进入下一轮
      logFile: join(proj, 'l.log')
    }
    await d.start(cfg, { path: fake, direct: false })
    for (let i = 0; i < 80 && d.state.runs < 1; i++) await sleep(25)
    expect(d.state.runs).toBe(1)

    const t0 = Date.now()
    d.restartNow()
    let reached = false
    for (let i = 0; i < 120 && !reached; i++) {
      await sleep(50)
      if (d.state.runs >= 2) reached = true
    }
    expect(reached).toBe(true)
    // 跳过延时后应在数秒内进入第 2 轮（含杀进程与闸门开销）；未修复则 >= 8 秒
    expect(Date.now() - t0).toBeLessThan(6000)
    await d.stop('测试停止')
    expect(d.state.status).toBe('stopped')
  }, 25000)
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
