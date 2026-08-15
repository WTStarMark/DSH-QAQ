import { describe, it, expect } from 'vitest'
import { resolveLang, makeT, isLang } from '../src/i18n.ts'

describe('i18n', () => {
  it('defaults to zh without flags or env', () => {
    expect(resolveLang([], {})).toBe('zh')
  })

  it('prefers --lang over $QAQ_LANG over the zh default', () => {
    expect(resolveLang(['--lang', 'en'], { QAQ_LANG: 'zh' })).toBe('en')
    expect(resolveLang(['console', '--lang', 'zh'], { QAQ_LANG: 'en' })).toBe('zh')
    expect(resolveLang([], { QAQ_LANG: 'EN' })).toBe('en')
    expect(resolveLang([], { QAQ_LANG: 'de' })).toBe('zh')
  })

  it('interpolates vars and falls back to the key when missing', () => {
    expect(makeT('en')('env.PORT_BUSY.msg', { port: 3080 })).toBe('Port 3080 is already in use.')
    expect(makeT('zh')('console.menu.prompt')).toBe('请选择: ')
    expect(makeT('en')('console.menu.prompt')).toBe('Please choose: ')
    expect(makeT('en')('no.such.key')).toBe('no.such.key')
  })

  it('isLang guards only the two supported locales', () => {
    expect(isLang('en')).toBe(true)
    expect(isLang('zh')).toBe(true)
    expect(isLang('de')).toBe(false)
    expect(isLang(undefined)).toBe(false)
  })
})
