/** Path helpers. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Default DSH home env name. */
export const DSH_HOME_ENV = 'DSH_HOME'
/** Directory name for the default DSH home. */
export const DSH_HOME_DIR_NAME = '.dsh'
/** QAQ state root under the DSH home. */
export const QAQ_DIR_NAME = '.qaq'

/** Resolve the DSH home, honoring $DSH_HOME then ~/.dsh. */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(selected)
}

/** QAQ state directory under the DSH home. */
export function qaqDir(home = resolveDshHome()): string {
  return join(home, QAQ_DIR_NAME)
}

/** A profile directory under the DSH home. */
export function profileDir(home: string, name: string): string {
  return join(home, 'profiles', name)
}

/** The launcher-maintained flat module fallback under the home. */
export function profilesNodeModules(home: string): string {
  return join(home, 'profiles', 'node_modules')
}
