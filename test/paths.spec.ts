import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveDshHome, qaqDir, profileDir, profilesNodeModules, DSH_HOME_ENV, DSH_HOME_DIR_NAME, QAQ_DIR_NAME } from '../src/paths.ts'
import { join } from 'node:path'

describe('paths helpers', () => {
  it('resolves the default DSH home to ~/.dsh when DSH_HOME is unset/blank', () => {
    expect(resolveDshHome({})).toBe(resolve(join(homedir(), DSH_HOME_DIR_NAME)))
    expect(resolveDshHome({ [DSH_HOME_ENV]: '' })).toBe(resolve(join(homedir(), DSH_HOME_DIR_NAME)))
    expect(resolveDshHome({ [DSH_HOME_ENV]: '   ' })).toBe(resolve(join(homedir(), DSH_HOME_DIR_NAME)))
  })

  it('honors an explicit DSH_HOME', () => {
    expect(resolveDshHome({ [DSH_HOME_ENV]: 'C:/custom/dsh' })).toBe(resolve('C:/custom/dsh'))
    expect(resolveDshHome({ [DSH_HOME_ENV]: '/tmp/x' })).toBe(resolve('/tmp/x'))
  })

  it('qaqDir is the home joined with .qaq', () => {
    expect(qaqDir('/home/test')).toBe(join('/home/test', QAQ_DIR_NAME))
    // Platform-independent: the directory separator is whatever node:path uses.
    expect(qaqDir('/a/b')).toBe(join('/a/b', QAQ_DIR_NAME))
  })

  it('profileDir and profilesNodeModules resolve under the given home', () => {
    expect(profileDir('/home', 'web')).toBe(join('/home', 'profiles', 'web'))
    expect(profileDir('/home', 'beta')).toBe(join('/home', 'profiles', 'beta'))
    expect(profilesNodeModules('/home')).toBe(join('/home', 'profiles', 'node_modules'))
  })
})
