import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEED,
  feedFromAppUpdateYml,
  githubLatestUrl,
  parseSemver,
  compareSemver,
  normalizeRelease,
  checkForUpdate
} from '../src/main/updater.js'

describe('feedFromAppUpdateYml（更新源解析）', () => {
  const yml = `owner: smoothwind\nrepo: OpenCodeLoop\nprovider: github\nupdaterCacheDirName: opencodeloop-updater\n`

  it('解析 github provider 的 owner/repo', () => {
    expect(feedFromAppUpdateYml(yml)).toEqual({ owner: 'smoothwind', repo: 'OpenCodeLoop' })
  })

  it('非 github / 缺字段返回 null', () => {
    expect(feedFromAppUpdateYml('owner: a\nrepo: b\nprovider: generic')).toBeNull()
    expect(feedFromAppUpdateYml('owner: a')).toBeNull()
    expect(feedFromAppUpdateYml('')).toBeNull()
    expect(feedFromAppUpdateYml(null)).toBeNull()
  })

  it('githubLatestUrl 拼接查询地址', () => {
    expect(githubLatestUrl(DEFAULT_FEED)).toBe('https://api.github.com/repos/smoothwind/OpenCodeLoop/releases/latest')
    expect(githubLatestUrl(null)).toBe('')
  })
})

describe('parseSemver / compareSemver', () => {
  it('解析 v 前缀与预发布后缀', () => {
    expect(parseSemver('v0.1.2')).toEqual({ major: 0, minor: 1, patch: 2, pre: null })
    expect(parseSemver('0.2.0-beta.1')).toEqual({ major: 0, minor: 2, patch: 0, pre: 'beta.1' })
    expect(parseSemver('1.2')).toBeNull()
    expect(parseSemver('abc')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })

  it('数值比较与预发布规则', () => {
    expect(compareSemver('0.1.2', '0.1.1')).toBe(1)
    expect(compareSemver('0.1.1', '0.1.2')).toBe(-1)
    expect(compareSemver('v0.1.1', '0.1.1')).toBe(0)
    expect(compareSemver('0.2.0', '0.1.9')).toBe(1)
    expect(compareSemver('0.1.2-beta.1', '0.1.2')).toBe(-1)
    expect(compareSemver('0.1.2-beta.1', '0.1.2-beta.2')).toBe(-1)
    expect(compareSemver('0.1.2-beta.1', '0.1.2-alpha')).toBe(1)
    expect(compareSemver('0.1.2-1', '0.1.2-a')).toBe(-1)
    expect(compareSemver('bad', '0.1.1')).toBe(0)
  })
})

describe('normalizeRelease', () => {
  it('映射版本/链接/说明，容错缺字段', () => {
    const r = normalizeRelease({
      tag_name: 'v0.2.0',
      name: 'v0.2.0 发布',
      html_url: 'https://github.com/smoothwind/OpenCodeLoop/releases/tag/v0.2.0',
      body: '- 修复若干问题',
      published_at: '2026-10-25T00:00:00Z'
    })
    expect(r.version).toBe('0.2.0')
    expect(r.tagName).toBe('v0.2.0')
    expect(r.url).toContain('/releases/tag/v0.2.0')
    expect(r.notes).toContain('修复若干问题')
    expect(normalizeRelease({ tag_name: 'not-semver' }).version).toBe('')
  })
})

describe('checkForUpdate（只查询元数据，不下载）', () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body })

  it('有新版本 → available 并带版本/链接', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.1',
      fetchImpl: ok({ tag_name: 'v0.2.0', html_url: 'https://example.com/r/0.2.0', body: 'notes' })
    })
    expect(r.status).toBe('available')
    expect(r.version).toBe('0.2.0')
    expect(r.current).toBe('0.1.1')
    expect(r.url).toBe('https://example.com/r/0.2.0')
  })

  it('同版本/旧版本 → latest；预发布新版本也算 available', async () => {
    const same = await checkForUpdate({ currentVersion: '0.2.0', fetchImpl: ok({ tag_name: 'v0.2.0' }) })
    expect(same.status).toBe('latest')
    const old = await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: ok({ tag_name: 'v0.2.0' }) })
    expect(old.status).toBe('latest')
    const pre = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: ok({ tag_name: 'v0.1.2-beta.1' }) })
    expect(pre.status).toBe('available')
  })

  it('404 → none；HTTP 错误 → error', async () => {
    const none = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: async () => ({ ok: false, status: 404 }) })
    expect(none.status).toBe('none')
    const err = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: async () => ({ ok: false, status: 403 }) })
    expect(err.status).toBe('error')
    expect(err.error).toContain('403')
  })

  it('网络异常 → error；非法 tag → error', async () => {
    const boom = await checkForUpdate({
      currentVersion: '0.1.1',
      fetchImpl: async () => {
        throw new Error('network down')
      }
    })
    expect(boom.status).toBe('error')
    expect(boom.error).toContain('network down')
    const bad = await checkForUpdate({ currentVersion: '0.1.1', fetchImpl: ok({ tag_name: 'hello' }) })
    expect(bad.status).toBe('error')
  })

  it('当前版本号非法 → error（不发起请求）', async () => {
    let called = 0
    const r = await checkForUpdate({
      currentVersion: 'dev',
      fetchImpl: async () => {
        called++
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9' }) }
      }
    })
    expect(r.status).toBe('error')
    expect(called).toBe(0)
  })
})
