/**
 * qaq-manifest-verifier — the CLI side of guard plan A: never bless an
 * on-disk profile config as last-good unless the currently-running DSH actually
 * booted with THAT config.
 *
 * Background: `recordSuccess` (see rollback.ts) snapshots the profile's
 * package.json bundle list + cordis.patch.yml as last-good whenever a DOM probe
 * reports the UI healthy. But a BUNDLE-layer edit (e.g. enabling a plugin via
 * the TUI plugin manager) only takes effect on the NEXT DSH restart — the live
 * process keeps running the OLD bundle set and still looks healthy. Blessing the
 * new (not-yet-loaded) on-disk config as last-good is exactly how a broken
 * bundle got recorded as good in the wild: the running process healthily used
 * the old config, while the snapshot captured the edited (broken) one.
 *
 * The fix closes that gap with a "loaded config fingerprint": the in-process
 * dsh-qaq plugin records, ONCE at boot, the fingerprint of the profile config it
 * actually consumed (`loadedFingerprint` in plugin-state.json) and keeps
 * reporting that snapshot (never re-reading the disk, so a post-boot edit is not
 * mistaken for "loaded"). Before blessing last-good, the guard compares the
 * CURRENT on-disk fingerprint against that loaded fingerprint:
 *
 *   - equal      -> the running process loaded exactly the config being blessed  (bless)
 *   - different  -> the running process is on an OLDER config; the on-disk config
 *                   has never been proven to boot -> REFUSE to bless
 *   - unknown    -> the plugin did not report a fingerprint yet (offline, or an
 *                   older dsh-qaq without this field). Fall back to today's
 *                   behavior so nothing regresses.
 *
 * The fingerprint algorithm is intentionally tiny and dependency-free so the
 * zero-dependency dsh-qaq plugin can inline an exact copy (see
 * packages/dsh-qaq/src/index.ts, configFingerprint) — both sides must agree.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profileDir } from './paths.ts'
import { readPluginState } from './shared-io.ts'

/** Canonicalize the profile config into one stable string. Missing patch layer
 *  contributes ''; an unreadable manifest contributes nothing. */
export function canonicalConfig(profileDirPath: string): string {
  let bundles = ''
  let patch = ''
  try {
    const pj = join(profileDirPath, 'package.json')
    if (existsSync(pj)) {
      const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
      const b = pkg?.dsh?.profile?.bundles
      if (Array.isArray(b)) bundles = JSON.stringify(b.map(String))
    }
  } catch { /* unreadable -> empty */ }
  try {
    const cp = join(profileDirPath, 'cordis.patch.yml')
    if (existsSync(cp)) patch = readFileSync(cp, 'utf8')
  } catch { /* unreadable -> empty */ }
  return bundles + '\u0001' + patch
}

/** FNV-1a 32-bit hash → 8-char lowercase hex. Deterministic, zero-dependency. */
export function fnv1aHex(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** The stable config fingerprint for a profile dir (what a last-good snapshot
 *  would capture). Shared with the dsh-qaq plugin's inline copy. */
export function configFingerprint(profileDirPath: string): string {
  return fnv1aHex(canonicalConfig(profileDirPath))
}

/** Result of checking whether the live DSH boot actually loaded the on-disk
 *  config. true=bless, false=refuse, null=can't tell (fall back to today). */
export type LiveBootMatch = { match: boolean | null; reason?: string }

/** The dsh-qaq plugin-state field that carries the boot-time fingerprint. */
export const LOADED_FINGERPRINT_FIELD = 'loadedFingerprint'

/**
 * Compare the CURRENT on-disk profile config against the fingerprint the running
 * DSH reported at boot. Uses the plugin-state channel (see shared-io.ts). When
 * the plugin is not reporting (offline or an older build without the field),
 * returns { match: null } so the guard keeps today's permissive behavior.
 */
export function liveBootMatches(home: string, profile: string): LiveBootMatch {
  const state = readPluginState(home)
  const loaded = state?.loadedFingerprint
  if (typeof loaded !== 'string' || loaded === '') {
    return { match: null, reason: 'no loaded-fingerprint reported by plugin (offline/older build)' }
  }
  const cur = configFingerprint(profileDir(home, profile))
  if (cur === loaded) return { match: true }
  return {
    match: false,
    reason: 'on-disk config differs from what the running DSH loaded (a config change is pending a restart); refusing to bless it as last-good.',
  }
}
