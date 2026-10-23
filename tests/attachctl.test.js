import { describe, expect, it } from 'vitest'
import { parseAttachTarget } from '../src/main/attachctl.js'

describe('parseAttachTarget', () => {
  it('解析端口与主机名（localhost → 127.0.0.1）', () => {
    const t = parseAttachTarget('http://localhost:4096')
    expect(t).toEqual({ port: 4096, hostname: '127.0.0.1', healthUrl: 'http://localhost:4096' })
  })

  it('无端口 http 默认 80', () => {
    expect(parseAttachTarget('http://example.com').port).toBe(80)
  })

  it('IP 主机名原样保留', () => {
    expect(parseAttachTarget('http://192.168.1.5:4096').hostname).toBe('192.168.1.5')
  })

  it('非法地址返回 error', () => {
    expect(parseAttachTarget('not-a-url').error).toContain('无效')
    expect(parseAttachTarget('ftp://x').error).toContain('http(s)')
    expect(parseAttachTarget('').error).toContain('无效')
  })
})
