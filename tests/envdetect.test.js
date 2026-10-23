import { describe, expect, it } from 'vitest'
import { parseWhereOutput, firstLineOf, opencodeGlobalRoot } from '../src/main/envdetect.js'

describe('parseWhereOutput', () => {
  it('拆行去空去空白', () => {
    expect(parseWhereOutput('C:\\a\\node.exe\r\nC:\\b\\node.exe\n\n')).toEqual([
      'C:\\a\\node.exe',
      'C:\\b\\node.exe'
    ])
  })
  it('空输出返回空数组', () => {
    expect(parseWhereOutput('')).toEqual([])
  })
})

describe('firstLineOf', () => {
  it('取首行并裁剪', () => {
    expect(firstLineOf('  v24.19.0\r\nnext')).toBe('v24.19.0')
  })
  it('空值返回空串', () => {
    expect(firstLineOf('')).toBe('')
  })
})

describe('opencodeGlobalRoot', () => {
  it('从 exe 路径推导 npm 全局根（反斜杠）', () => {
    expect(
      opencodeGlobalRoot('C:\\nodejs\\node_modules\\@opencode\\cli\\bin\\opencode.exe')
    ).toBe('C:\\nodejs')
  })
  it('兼容正斜杠', () => {
    expect(opencodeGlobalRoot('C:/nodejs/node_modules/@opencode/cli/bin/opencode.exe')).toBe('C:/nodejs')
  })
  it('非该布局返回 null', () => {
    expect(opencodeGlobalRoot('C:\\bin\\opencode.exe')).toBeNull()
    expect(opencodeGlobalRoot('')).toBeNull()
  })
})
